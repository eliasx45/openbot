import type { QueueDelivery } from "@openbot/contracts/ipc";
import { agentActivityExitDuration } from "@openbot/ui/features/conversation/activity-timing";
import { type Accessor, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { agentAwaitingReplies } from "../../../awaiting-replies";
import { activeQueueDeliveries, presentQueueDeliveries, queuedDeliveriesInOrder } from "../../../queue-reconciliation";
import type { ConversationProps } from "../conversation-types";
import { currentConversationTarget } from "./composer-store";
import { PENDING_SEND_ID_PREFIX, type PendingSend } from "./pending-send-store";

export interface QueueStoreDeps {
  props: ConversationProps;
  hiddenAwaitingReplyIds: Accessor<ReadonlySet<string>>;
  startingDeliveryIds: Accessor<ReadonlySet<string>>;
  /** Fork (docs/fork/FEATURES.md #132): this composer's sends, and the host deliveries matched to them. */
  pendingSends?: Accessor<readonly PendingSend[]>;
  queuedSendDeliveryIds?: Accessor<ReadonlyMap<string, string>>;
}

/** Fork (docs/fork/FEATURES.md #132): the queue row of a queued send that the host has not listed yet. */
function sendingQueueRow(send: PendingSend, agentId: string): QueueDelivery {
  const id = `${PENDING_SEND_ID_PREFIX}${send.clientMessageId}`;
  return {
    id,
    messageId: id,
    recipientAgentId: agentId,
    sender: { kind: "user" },
    text: send.text,
    attachments: send.draft.attachments,
    replyToMessageId: send.draft.replyToMessageId,
    status: "queued",
    position: null,
    turnId: null,
    error: null,
    createdAt: send.createdAt,
  };
}

/**
 * Fork (docs/fork/FEATURES.md #132): the panel rows of this composer's queued sends that the host has not
 * listed yet, and, for each listed one, the sending row its host row replaces.
 */
export function queueSendingRows(input: {
  agentId: string;
  sends: readonly PendingSend[];
  deliveries: readonly QueueDelivery[];
  messageIds: ReadonlySet<string>;
  matched: ReadonlyMap<string, string>;
}): { rows: QueueDelivery[]; handoffs: Map<string, string> } {
  const rows: QueueDelivery[] = [];
  const handoffs = new Map<string, string>();
  const listed = new Set(input.deliveries.map((delivery) => delivery.id));
  for (const send of input.sends) {
    if (!send.queued || send.state === "failed") continue;
    const deliveryId = send.messageId ?? input.matched.get(send.clientMessageId);
    if (deliveryId && listed.has(deliveryId)) {
      handoffs.set(deliveryId, `${PENDING_SEND_ID_PREFIX}${send.clientMessageId}`);
      continue;
    }
    if (deliveryId && input.messageIds.has(deliveryId)) continue;
    rows.push(sendingQueueRow(send, input.agentId));
  }
  return { rows, handoffs };
}

export function createQueueStore(deps: QueueStoreDeps) {
  const activeDeliveries = createMemo(() => activeQueueDeliveries(deps.props.queue, deps.props.activeTurnId));
  const orderedQueuedDeliveries = createMemo(() => queuedDeliveriesInOrder(deps.props.queue));
  const presentedQueueDeliveries = createMemo(() => {
    const presented = presentQueueDeliveries({
      snapshot: deps.props.queue,
      activeTurnId: deps.props.activeTurnId,
      renderedMessageIds: new Set(deps.props.messages.map((message) => message.id)),
    });
    if (deps.props.queue?.hold) return presented;
    const starting = deps.startingDeliveryIds();
    return starting.size ? presented.filter((delivery) => !starting.has(delivery.id)) : presented;
  });
  // Fork (docs/fork/FEATURES.md #132): a queued send shows in the panel at once, as a row that waits for
  // the host, never as a chat bubble. When the host lists its delivery, that row takes the same place.
  const sendingRows = createMemo(() => {
    const sends = deps.pendingSends?.() ?? [];
    const agentId = deps.props.agent?.id;
    if (!agentId || sends.length === 0 || deps.props.channel) return { rows: [], handoffs: new Map<string, string>() };
    return queueSendingRows({
      agentId,
      sends,
      deliveries: deps.props.queue?.deliveries ?? [],
      messageIds: new Set(deps.props.messages.map((message) => message.id)),
      matched: deps.queuedSendDeliveryIds?.() ?? new Map<string, string>(),
    });
  });
  const panelDeliveries = createMemo(() => {
    const sending = sendingRows().rows;
    return sending.length ? [...presentedQueueDeliveries(), ...sending] : presentedQueueDeliveries();
  });
  const sendingQueueIds = createMemo(() => new Set(sendingRows().rows.map((row) => row.id)));
  const queueHandoffs = createMemo(() => sendingRows().handoffs);
  const awaitingReplies = createMemo(() => {
    const hidden = deps.hiddenAwaitingReplyIds();
    return agentAwaitingReplies({
      messages: deps.props.messages,
      queue: deps.props.queue?.agentId === deps.props.agent?.id ? deps.props.queue : undefined,
      agents: deps.props.agents,
      self: deps.props.agent,
      waits: deps.props.agentWaits,
    }).filter((row) => !(hidden.has(row.id) && (row.state === "replied" || row.state === "failed")));
  });
  const [renderedQueueDeliveries, setRenderedQueueDeliveries] = createSignal<QueueDelivery[]>([]);
  const queuePanelVisible = createMemo(() => renderedQueueDeliveries().length > 0);
  const queueOpen = createMemo(() => panelDeliveries().length > 0);
  let queueExitTimer: number | undefined;
  let renderedOwner: string | undefined;
  createEffect(
    () => {
      const target = currentConversationTarget(deps.props);
      return { deliveries: panelDeliveries(), owner: target && `${target.serverId}:${target.agentId}` };
    },
    ({ deliveries, owner }) => {
      const switched = owner !== renderedOwner;
      renderedOwner = owner;
      if (deliveries.length > 0 || switched) {
        if (queueExitTimer !== undefined) window.clearTimeout(queueExitTimer);
        queueExitTimer = undefined;
      }
      if (deliveries.length > 0) {
        setRenderedQueueDeliveries(deliveries);
        return;
      }
      if (untrack(renderedQueueDeliveries).length === 0) return;
      if (switched) {
        setRenderedQueueDeliveries([]);
        return;
      }
      if (queueExitTimer !== undefined) return;
      queueExitTimer = window.setTimeout(() => {
        queueExitTimer = undefined;
        if (untrack(panelDeliveries).length === 0) setRenderedQueueDeliveries([]);
      }, agentActivityExitDuration());
    },
  );
  onCleanup(() => {
    if (queueExitTimer !== undefined) window.clearTimeout(queueExitTimer);
  });

  return {
    activeDeliveries,
    awaitingReplies,
    orderedQueuedDeliveries,
    presentedQueueDeliveries,
    panelDeliveries,
    sendingQueueIds,
    queueHandoffs,
    renderedQueueDeliveries,
    setRenderedQueueDeliveries,
    queuePanelVisible,
    queueOpen,
  };
}
