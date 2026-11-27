import {
  type AgentTask,
  deliveryWaitsForProvider,
  isQueuedAgentReply,
  type QueueDelivery,
  type QueueSnapshot,
  routineRunsTurn,
} from "@openbot/contracts/ipc";

export function withoutSideThreadTurns(queue: QueueSnapshot, tasks: readonly AgentTask[]): QueueSnapshot {
  const sideTurns = new Set(tasks.flatMap((task) => (task.activeTurnId ? [task.activeTurnId] : [])));
  if (sideTurns.size === 0) return queue;
  const deliveries = queue.deliveries.filter((delivery) => delivery.turnId === null || !sideTurns.has(delivery.turnId));
  return deliveries.length === queue.deliveries.length ? queue : { ...queue, deliveries };
}

export function activeQueueDeliveries(
  snapshot: QueueSnapshot | undefined,
  activeTurnId: string | null | undefined,
): QueueDelivery[] {
  const running = (snapshot?.deliveries ?? []).filter(
    (delivery) => delivery.status === "starting" || delivery.status === "running",
  );
  if (!activeTurnId) return running;
  const matching = running.filter((delivery) => delivery.turnId === activeTurnId || delivery.turnId === null);
  return matching.length > 0 ? matching : running;
}

export function queuedDeliveriesInOrder(snapshot: QueueSnapshot | undefined): QueueDelivery[] {
  return [...(snapshot?.deliveries ?? [])]
    .filter((delivery) => delivery.status === "queued")
    .sort((left, right) => {
      const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt);
    });
}

export function presentQueueDeliveries(input: {
  snapshot: QueueSnapshot | undefined;
  activeTurnId: string | null | undefined;
  renderedMessageIds: ReadonlySet<string>;
}): QueueDelivery[] {
  const snapshot = input.snapshot;
  if (!snapshot) return [];
  const queued = queuedDeliveriesInOrder(snapshot).filter(
    (delivery) =>
      (!input.activeTurnId || delivery.turnId !== input.activeTurnId) &&
      !input.renderedMessageIds.has(delivery.id) &&
      !isQueuedAgentReply(delivery),
  );
  // Fork (docs/fork/FEATURES.md #132): a row the host is starting (drain, turnId null) or steering into
  // the running turn stays in the panel until the provider takes it and the chat shows it.
  const steering = snapshot.deliveries.filter(
    (delivery) =>
      deliveryWaitsForProvider(delivery) &&
      (delivery.turnId === null || (Boolean(input.activeTurnId) && delivery.turnId === input.activeTurnId)) &&
      !input.renderedMessageIds.has(delivery.id),
  );
  return [...queued, ...steering];
}

export function queueAfterTurnCompleted(snapshot: QueueSnapshot, turnId: string): QueueSnapshot {
  const deliveries = snapshot.deliveries.filter(
    (delivery) =>
      !(
        (delivery.status === "starting" || delivery.status === "running") &&
        (delivery.turnId === null || delivery.turnId === turnId)
      ),
  );
  return deliveries.length === snapshot.deliveries.length ? snapshot : { ...snapshot, deliveries };
}

/**
 * Fork (docs/fork/FEATURES.md #132): whether a message sent now can join the running turn, by the
 * host's own rules: a turn runs, it is not a routine run's turn (the host never steers into one), and
 * the queue is not held. Otherwise the message waits, so the composer puts it straight in the queue
 * panel instead of drawing a sent bubble that the panel takes back a moment later.
 */
export function runningTurnTakesMessages(
  snapshot: QueueSnapshot | undefined,
  activeTurnId: string | null | undefined,
): boolean {
  return Boolean(activeTurnId) && !routineRunsTurn(snapshot?.deliveries, activeTurnId) && !snapshot?.hold;
}
