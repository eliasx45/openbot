import {
  type AgentEvent,
  type AgentSummary,
  type AgentTurnCompletedEvent,
  type ConversationMessage,
  latestTurnAnswer,
  type ServerNotificationLevel,
} from "@openbot/contracts/ipc";
import type { LiveActivityRelayPush } from "@openbot/contracts/live-activity-relay";
import {
  type AndroidNotificationRelayPush,
  NOTIFICATION_SEALED_LIMIT,
  type NotificationRelayPush,
  type NotificationSound,
} from "@openbot/contracts/notification-relay";
import { TEAM_CHANNEL_ATTENTION_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { PUSH_NOTIFICATION_THREADS_CAPABILITY } from "@openbot/contracts/team-protocol/push-notification-threads-v1";
import { resolveLocale, translateFor } from "@openbot/i18n";
import { redactText, toLogValue } from "@openbot/logging";
import {
  type AgentNotificationChannel,
  agentEventCanNotify,
  agentEventRequestThread,
  agentNotificationLevel,
  notificationForAgentEvent,
  notificationForSignInWait,
  type ProviderSignInWaitNotice,
  teammateTurnCompleted,
} from "@openbot/team-client/agent-notifications";
import {
  decodeLiveActivityBytes,
  LIVE_ACTIVITY_NONCE_BYTES,
  LIVE_ACTIVITY_SECRET_BYTES,
} from "@openbot/team-client/live-activity-seal";
import {
  type PushNotificationContent,
  type PushNotificationKeys,
  type PushNotificationKind,
  pushNotificationKeys,
  sealPushNotification,
} from "@openbot/team-client/push-notification-seal";
import { Effect, Exit, Fiber, Result, Schema, Scope } from "effect";
import type { ProviderSignInWait, ProviderSignInWaits } from "../backend/agent/provider-sign-in-waits";
import { isNoUpdateAnswer } from "../backend/agent/routine-quiet-runs";
import type { AgentService } from "../backend/agent-service";
import { forkHub } from "../backend/fork-hub";
import type { PushNotificationStore, PushTarget, StoredPushRegistration } from "./push-notification-store";
import type { TeamApiAgents } from "./team-api/dependencies";
import { markerExclusionsForCapabilities } from "./team-api/request-helpers";

const ANSWER_PAGE_SIZE = 20;
export const DESKTOP_USE_MS = 30 * 1000;
const HELD_EVENT_MS = 5 * 60 * 1000;
const HELD_EVENT_LIMIT = 20;
const HELD_FLUSH_DELAY_MS = 3_000;
export const WAITING_REQUEST_IDLE_MS = 2 * 60 * 1000;
export const ENDED_SUBAGENTS_GROUP_MS = 15_000;
const WAITING_REQUEST_POLL_MS = 15_000;
const RESEND_DELAYS_MS = [10_000, 60_000] as const;

export type NotificationRelayRequest =
  | { platform: "ios"; push: NotificationRelayPush }
  | { platform: "android"; push: AndroidNotificationRelayPush };

type PushNotificationAgents = Pick<
  TeamApiAgents,
  "on" | "off" | "listAgents" | "readConversationPageFor" | "getRuntimeSnapshot" | "listConversationReads"
> &
  Pick<AgentService, "readTask">;

type PushNotice = AgentEvent | ProviderSignInWaitNotice;

interface PushNotificationOptions {
  agents: PushNotificationAgents;
  signInWaits?: Pick<ProviderSignInWaits, "on" | "off">;
  store: Pick<PushNotificationStore, "list" | "replace">;
  send(request: NotificationRelayRequest): Effect.Effect<"sent" | "gone", PushNotificationSendFailure>;
  hiddenAgentIds(protocol: number, capabilities: ReadonlySet<string>, memberId: string): ReadonlySet<string>;
  memberActive(memberId: string): boolean;
  lastUseElsewhere(memberId: string, sessionId: string): number | null;
  awayAfterMs?: number;
  memberLevels?(memberId: string): {
    server: ServerNotificationLevel | null;
    agents: ReadonlyMap<string, ServerNotificationLevel>;
  };
  atHostComputer(memberId: string, event: AgentEvent | null): boolean;
  hostIdleSeconds?(): number | null;
  idleRequestAfterMs?: number;
  liveActivityShows(
    sessionId: string,
    subject: PushNotificationSubject,
    alert: LiveActivityRelayPush["alert"],
    startedAt: number | null,
  ): boolean;
  channelForThread?(threadId: string): AgentNotificationChannel | null;
  /** Fork (docs/fork/FEATURES.md #107): the member cannot see this channel (level `none`). */
  channelClosed?(memberId: string, channelId: string): boolean;
  randomBytes(size: number): Uint8Array;
  now?: () => number;
  logger?: { warn(message: string, ...values: unknown[]): void };
}

interface PushNotificationViewer {
  memberId: string;
  protocol: number;
  capabilities: ReadonlySet<string>;
}

export interface PushNotificationSubject {
  agentId: string;
  kind: PushNotificationKind;
  sideThread?: boolean;
}

interface HeldEvent {
  event: PushNotice;
  at: number;
}

/** A request that the phone did not get because the member was at a computer. */
interface WaitingRequest {
  event: AgentEvent;
  /** `true` when the member was at the computer of this host, so its idle time counts too. */
  atHost: boolean;
}

interface Registration {
  stored: StoredPushRegistration;
  capabilities: ReadonlySet<string>;
  keys: PushNotificationKeys;
  connected: boolean;
  held: HeldEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Requests that go to the phone when the member leaves the computer, oldest first. */
  waiting: WaitingRequest[];
}

export class PushNotificationService {
  readonly #options: PushNotificationOptions;
  readonly #now: () => number;
  readonly #registrations = new Map<string, Registration>();
  readonly #computerInput = new Map<string, { memberId: string; at: number }>();
  readonly #awayAfterMs: number;
  readonly #idleRequestAfterMs: number;
  /** Runs only while a phone has a waiting request. */
  #idleTimer: ReturnType<typeof setInterval> | null = null;
  readonly #listener = (event: AgentEvent) => {
    this.#releaseAnswered(event);
    if (event.type === "subagents-ended") {
      this.#groupEnded(event);
      return;
    }
    Effect.runFork(this.#deliver(event).pipe(Effect.forkIn(this.#scope, { startImmediately: true })));
  };
  readonly #endedGroups = new Map<string, { event: EndedSubagentsEvent; timer: ReturnType<typeof setTimeout> }>();
  readonly #signInListener = (wait: ProviderSignInWait) => {
    const notice: ProviderSignInWaitNotice = { type: "provider-sign-in-wait", ...wait };
    Effect.runFork(this.#deliver(notice).pipe(Effect.forkIn(this.#scope, { startImmediately: true })));
  };
  #scope = Scope.makeUnsafe();
  #listening = false;
  #running = false;
  readonly #saves = new Set<Fiber.Fiber<void>>();

  constructor(options: PushNotificationOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#awayAfterMs = options.awayAfterMs ?? DESKTOP_USE_MS;
    this.#idleRequestAfterMs = options.idleRequestAfterMs ?? WAITING_REQUEST_IDLE_MS;
  }

  computerInput(sessionId: string, memberId: string, idleSeconds: number): boolean {
    const now = this.#now();
    for (const [other, input] of this.#computerInput) {
      if (now - input.at >= this.#awayAfterMs) this.#computerInput.delete(other);
    }
    const at = now - idleSeconds * 1_000;
    if (now - at < this.#awayAfterMs) this.#computerInput.set(sessionId, { memberId, at });
    else this.#computerInput.delete(sessionId);
    return [...this.#registrations.values()].some((registration) => registration.stored.memberId === memberId);
  }

  #lastUseElsewhere(memberId: string, sessionId: string): number | null {
    let last = this.#options.lastUseElsewhere(memberId, sessionId);
    for (const [other, input] of this.#computerInput) {
      if (other !== sessionId && input.memberId === memberId && (last === null || input.at > last)) last = input.at;
    }
    return last;
  }

  start(): void {
    this.#running = true;
    for (const stored of this.#options.store.list()) {
      if (!this.#registrations.has(stored.sessionId)) this.#add(stored, false);
    }
    this.#listen();
  }

  register(sessionId: string, viewer: PushNotificationViewer, target: PushTarget): void {
    if (!this.#running) return;
    const { memberId, protocol, capabilities } = viewer;
    const previous = this.#registrations.get(sessionId);
    const threadReplies = previous?.stored.threadReplies;
    const threadChoice = threadReplies === undefined ? {} : { threadReplies };
    const stored = { sessionId, memberId, protocol, capabilities: [...capabilities], ...threadChoice, ...target };
    if (!this.#add(stored, true, previous)) throw new Error("The notification secret is not valid.");
    const registration = this.#registrations.get(sessionId);
    if (registration && target.value.away) this.#scheduleFlush(registration);
    else if (registration) this.#dropHeld(registration);
    const token = target.value.token;
    for (const [other, registration] of this.#registrations) {
      if (other !== sessionId && token !== null && registration.stored.value.token === token) {
        this.#registrations.delete(other);
      }
    }
    this.#listen();
    this.#save();
  }

  setThreadReplies(sessionId: string, replies: boolean): void {
    const registration = this.#registrations.get(sessionId);
    if (!this.#running || !registration) return;
    if (registration.stored.threadReplies === replies) return;
    registration.stored = { ...registration.stored, threadReplies: replies };
    this.#save();
  }

  disconnected(sessionId: string): void {
    const registration = this.#registrations.get(sessionId);
    if (!registration) return;
    registration.connected = false;
    this.#scheduleFlush(registration);
  }

  reconnected(sessionId: string): void {
    const registration = this.#registrations.get(sessionId);
    if (!registration) return;
    registration.connected = true;
    if (!registration.stored.value.away) this.#dropHeld(registration);
  }

  remove(sessionId: string): void {
    this.#computerInput.delete(sessionId);
    const registration = this.#registrations.get(sessionId);
    if (!this.#running || !registration) return;
    this.#dropHeld(registration);
    this.#registrations.delete(sessionId);
    this.#save();
  }

  #groupEnded(event: EndedSubagentsEvent): void {
    const news = event.subagents.filter((subagent) => subagent.status !== "stopped");
    if (!news.length) return;
    const group = this.#endedGroups.get(event.agentId);
    if (group) {
      group.event = mergeEnded(group.event, { ...event, subagents: news });
      return;
    }
    const timer = setTimeout(() => {
      const ready = this.#endedGroups.get(event.agentId);
      this.#endedGroups.delete(event.agentId);
      if (!ready || !this.#running) return;
      Effect.runFork(this.#deliver(ready.event).pipe(Effect.forkIn(this.#scope, { startImmediately: true })));
    }, ENDED_SUBAGENTS_GROUP_MS);
    this.#endedGroups.set(event.agentId, { event: { ...event, subagents: news }, timer });
  }

  readonly dispose = Effect.fn("PushNotifications.dispose")(function* (this: PushNotificationService) {
    this.#running = false;
    for (const group of this.#endedGroups.values()) clearTimeout(group.timer);
    this.#endedGroups.clear();
    if (this.#listening) {
      this.#options.agents.off("event", this.#listener);
      this.#options.signInWaits?.off("signInWait", this.#signInListener);
    }
    this.#listening = false;
    for (const registration of this.#registrations.values()) this.#dropHeld(registration);
    this.#registrations.clear();
    this.#computerInput.clear();
    this.#stopIdleTimer();
    yield* Fiber.awaitAll([...this.#saves]);
    yield* Scope.close(this.#scope, Exit.void);
    this.#scope = Scope.makeUnsafe();
  }, Effect.uninterruptible);

  #add(stored: StoredPushRegistration, connected: boolean, previous?: Registration): boolean {
    const secret = decodeLiveActivityBytes(stored.value.secret);
    if (secret?.length !== LIVE_ACTIVITY_SECRET_BYTES) return false;
    if (previous) this.#clearFlush(previous);
    this.#registrations.set(stored.sessionId, {
      stored,
      capabilities: new Set(stored.capabilities),
      keys: pushNotificationKeys(secret),
      connected,
      held: previous?.held ?? [],
      flushTimer: null,
      waiting: previous?.waiting ?? [],
    });
    return true;
  }

  #deliver = Effect.fn("PushNotifications.deliver")(function* (
    this: PushNotificationService,
    received: PushNotice,
    only?: Registration,
  ) {
    if (received.type === "provider-sign-in-wait") return yield* this.#deliverSignInWait(received, only);
    if (teammateTurnCompleted(received)) return;
    const thread = received.type === "thread-turn-completed" ? received : null;
    const event = thread ? thread.turn : received;
    const subject = eventSubject(event, thread !== null);
    if (!subject) return;
    const now = this.#now();
    const desktopNotifies = !thread || thread.routine;
    const targets = (only ? [only] : [...this.#registrations.values()]).filter((registration) => {
      if (
        thread &&
        !thread.routine &&
        (!registration.capabilities.has(PUSH_NOTIFICATION_THREADS_CAPABILITY) ||
          registration.stored.threadReplies === false)
      )
        return false;
      return this.#reaches(registration, received, subject.agentId, {
        desktopNotifies,
        hostEvent: desktopNotifies ? event : received,
        now,
        only,
      });
    });
    if (!targets.length) return;
    const agents = this.#options.agents.listAgents();
    const userHidden = agents.some((agent) => agent.id === subject.agentId && agent.hiddenAt !== undefined);
    const requestThread = agentEventRequestThread(event) ?? (event.type === "subagents-ended" ? event.threadId : null);
    const channel = requestThread ? (this.#options.channelForThread?.(requestThread) ?? null) : null;
    let answer: string | null | undefined;
    for (const registration of targets) {
      const { stored } = registration;
      const { value, memberId, sessionId } = stored;
      // Fork (docs/fork/FEATURES.md #107): no notice about a channel the member cannot see.
      if (channel && this.#options.channelClosed?.(memberId, channel.id)) continue;
      const translate = translateFor(resolveLocale("system", value.locale));
      const chosen = this.#options.memberLevels?.(memberId);
      const level = agentNotificationLevel(
        chosen?.server ?? value.level,
        chosen?.agents ?? null,
        subject.agentId,
        userHidden,
      );
      const eventChannel = registration.capabilities.has(TEAM_CHANNEL_ATTENTION_CAPABILITY) ? channel : null;
      const fixed = notificationForAgentEvent(event, agents, translate, level, null, eventChannel);
      if (!fixed) continue;
      if (stored.platform !== "android") {
        const sound = soundOf(stored.value);
        const startedAt =
          stored.value.liveActivityStartedAt === null ? null : stored.value.liveActivityStartedAt * 1_000;
        // The Live Activity does not show subagents, so their end always notifies.
        if (
          event.type !== "error" &&
          event.type !== "subagents-ended" &&
          this.#options.liveActivityShows(sessionId, subject, sound ? { sound } : null, startedAt)
        )
          continue;
        if (stored.value.token === null) continue;
      }
      if (value.preview && subject.kind === "reply" && event.type === "turn-completed" && answer === undefined) {
        answer = yield* this.#answer(event, memberId, agents, thread?.taskId ?? null);
      }
      const notice = value.preview
        ? (notificationForAgentEvent(
            event,
            agents,
            translate,
            level,
            { reply: answer ?? null, redact: redactText },
            eventChannel,
          ) ?? fixed)
        : fixed;
      const content: PushNotificationContent = {
        serverId: value.serverId,
        agentId: notice.agentId,
        threadId: notice.threadId,
        kind: subject.kind,
        title: notice.title,
        body: notice.body,
      };
      yield* this.#send(registration, content, fixed.body).pipe(Effect.forkIn(this.#scope, { startImmediately: true }));
    }
  });

  #deliverSignInWait = Effect.fn("PushNotifications.deliverSignInWait")(function* (
    this: PushNotificationService,
    notice: ProviderSignInWaitNotice,
    only?: Registration,
  ) {
    const now = this.#now();
    const targets = (only ? [only] : [...this.#registrations.values()]).filter((registration) =>
      this.#reaches(registration, notice, notice.agentId, { desktopNotifies: false, hostEvent: null, now, only }),
    );
    if (!targets.length) return;
    const agents = this.#options.agents.listAgents();
    const userHidden = agents.some((agent) => agent.id === notice.agentId && agent.hiddenAt !== undefined);
    for (const registration of targets) {
      const { stored } = registration;
      const { value, memberId } = stored;
      if (stored.platform !== "android" && stored.value.token === null) continue;
      const chosen = this.#options.memberLevels?.(memberId);
      const level = agentNotificationLevel(
        chosen?.server ?? value.level,
        chosen?.agents ?? null,
        notice.agentId,
        userHidden,
      );
      const translate = translateFor(resolveLocale("system", value.locale));
      const content = notificationForSignInWait(notice, agents, translate, level);
      if (!content) continue;
      const sealedContent: PushNotificationContent = {
        serverId: value.serverId,
        agentId: content.agentId,
        threadId: content.threadId,
        kind: "sign-in",
        title: content.title,
        body: content.body,
      };
      yield* this.#send(registration, sealedContent, content.body).pipe(
        Effect.forkIn(this.#scope, { startImmediately: true }),
      );
    }
  });

  #reaches(
    registration: Registration,
    received: PushNotice,
    agentId: string,
    delivery: { desktopNotifies: boolean; hostEvent: AgentEvent | null; now: number; only: Registration | undefined },
  ): boolean {
    const { value, memberId, protocol, sessionId } = registration.stored;
    const { now } = delivery;
    if (!value.away && registration.connected) {
      if (!delivery.only) this.#hold(registration, received, now);
      return false;
    }
    if (value.mutedUntil !== null && value.mutedUntil * 1_000 > now) return false;
    if (!this.#options.memberActive(memberId)) {
      this.remove(sessionId);
      return false;
    }
    if (this.#options.hiddenAgentIds(protocol, registration.capabilities, memberId).has(agentId)) return false;
    const used = delivery.desktopNotifies
      ? this.#lastUseElsewhere(memberId, sessionId)
      : this.#options.lastUseElsewhere(memberId, sessionId);
    const usedElsewhere = used !== null && now - used < this.#awayAfterMs;
    const atHost = this.#options.atHostComputer(memberId, delivery.hostEvent);
    if (usedElsewhere || atHost) {
      if (received.type !== "provider-sign-in-wait") this.#keepWaiting(registration, received, atHost);
      return false;
    }
    return true;
  }

  #answer = Effect.fn("PushNotifications.answer")(function* (
    this: PushNotificationService,
    event: AgentTurnCompletedEvent,
    memberId: string,
    agents: readonly AgentSummary[],
    taskId: string | null,
  ) {
    let messages: ConversationMessage[] | null = null;
    if (taskId) {
      messages = yield* Effect.try(() => this.#options.agents.readTask(event.agentId, taskId).messages).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
    } else if (agents.find((agent) => agent.id === event.agentId)?.threadId === event.threadId) {
      const page = yield* this.#options.agents
        .readConversationPageFor(event.agentId, memberId, undefined, ANSWER_PAGE_SIZE)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      messages = page?.messages ?? null;
    }
    const text = messages ? latestTurnAnswer(messages, event.turnId)?.text : undefined;
    return text && !isNoUpdateAnswer(text) ? text : null;
  });

  #send = Effect.fn("PushNotifications.send")(function* (
    this: PushNotificationService,
    registration: Registration,
    content: PushNotificationContent,
    shortBody: string,
  ) {
    const { stored, keys } = registration;
    let sealed = sealPushNotification(content, keys, this.#options.randomBytes(LIVE_ACTIVITY_NONCE_BYTES));
    if (sealed.length > NOTIFICATION_SEALED_LIMIT) {
      const short = { ...content, title: content.title.slice(0, 64), body: shortBody };
      sealed = sealPushNotification(short, keys, this.#options.randomBytes(LIVE_ACTIVITY_NONCE_BYTES));
    }
    const request = relayRequest(stored, sealed, Math.floor(this.#now() / 1_000));
    if (!request) return;
    for (let attempt = 0; ; attempt += 1) {
      const result = yield* Effect.result(this.#options.send(request));
      if (Result.isSuccess(result)) {
        if (result.success === "gone" && this.#registrations.get(stored.sessionId) === registration) {
          this.remove(stored.sessionId);
        }
        return;
      }
      const delay = RESEND_DELAYS_MS[attempt];
      if (delay === undefined) {
        this.#options.logger?.warn("Push notification was not sent:", toLogValue(result.failure.cause));
        return;
      }
      yield* Effect.sleep(delay);
      if (this.#registrations.get(stored.sessionId) !== registration) return;
    }
  });

  #hold(registration: Registration, event: PushNotice, now: number): void {
    const held = registration.held.filter((item) => now - item.at < HELD_EVENT_MS);
    held.push({ event, at: now });
    registration.held = held.slice(-HELD_EVENT_LIMIT);
  }

  #dropHeld(registration: Registration): void {
    this.#clearFlush(registration);
    registration.held = [];
    // The app on screen shows the waiting requests itself.
    registration.waiting = [];
  }

  /**
   * Fork (docs/fork/FEATURES.md, "Goal needs you" reaches the phone): a reply in the own chat of an
   * agent whose goal runs. When the goal waits for the member at send time (`goalWaitsForUser`), the
   * reply is the question. One per agent: a newer reply replaces it.
   */
  #goalReply(event: AgentEvent): { agentId: string; requestId: string } | null {
    if (event.type !== "turn-completed" || event.status !== "completed") return null;
    if (!forkHub.goals?.active(event.agentId)) return null;
    const own = this.#options.agents.listAgents().find((agent) => agent.id === event.agentId)?.threadId;
    return own === event.threadId ? { agentId: event.agentId, requestId: GOAL_REPLY } : null;
  }

  /** Keeps a request that waits for the member, so the phone gets it when the member leaves the computer. */
  #keepWaiting(registration: Registration, event: AgentEvent, atHost: boolean): void {
    // Fork: background work that ended while the member was at a computer goes to the phone when the
    // member leaves it, as a request does. A later end of the same agent joins it.
    if (event.type === "subagents-ended") {
      const index = registration.waiting.findIndex(
        (item) => item.event.type === "subagents-ended" && item.event.agentId === event.agentId,
      );
      const kept = registration.waiting[index];
      if (kept?.event.type === "subagents-ended")
        registration.waiting[index] = { event: mergeEnded(kept.event, event), atHost: kept.atHost || atHost };
      else registration.waiting = [...registration.waiting, { event, atHost }].slice(-HELD_EVENT_LIMIT);
      this.#idleTimer ??= setInterval(() => this.#sendWaiting(), WAITING_REQUEST_POLL_MS);
      return;
    }
    const request = heldRequest(event) ?? this.#goalReply(event);
    if (!request) return;
    const waiting = registration.waiting.filter(
      (item) => !sameRequest(heldRequest(item.event) ?? this.#goalReply(item.event), request),
    );
    waiting.push({ event, atHost });
    registration.waiting = waiting.slice(-HELD_EVENT_LIMIT);
    this.#idleTimer ??= setInterval(() => this.#sendWaiting(), WAITING_REQUEST_POLL_MS);
  }

  #stopIdleTimer(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#idleTimer = null;
  }

  /**
   * Sends each waiting request that still waits after the member left the computer, one time only.
   * `#deliver` checks the phone again: on screen, mute, level, hidden agent and Live Activity.
   */
  #sendWaiting(): void {
    const registrations = [...this.#registrations.values()].filter((registration) => registration.waiting.length);
    const now = this.#now();
    const hostIdle = this.#options.hostIdleSeconds?.() ?? null;
    const hostAway = hostIdle === null || hostIdle * 1_000 >= this.#idleRequestAfterMs;
    let snapshot: ReturnType<PushNotificationAgents["getRuntimeSnapshot"]> | undefined;
    for (const registration of registrations) {
      const { memberId, sessionId } = registration.stored;
      const used = this.#lastUseElsewhere(memberId, sessionId);
      const awayElsewhere = used === null || now - used >= this.#idleRequestAfterMs;
      const due = registration.waiting.filter((item) => awayElsewhere && (hostAway || !item.atHost));
      if (!due.length) continue;
      registration.waiting = registration.waiting.filter((item) => !due.includes(item));
      snapshot ??= this.#options.agents.getRuntimeSnapshot();
      for (const { event } of due) {
        if (!requestStillWaits(event, snapshot)) continue;
        Effect.runFork(this.#deliver(event, registration).pipe(Effect.forkIn(this.#scope, { startImmediately: true })));
      }
    }
    if (![...this.#registrations.values()].some((registration) => registration.waiting.length)) this.#stopIdleTimer();
  }

  #clearFlush(registration: Registration): void {
    if (registration.flushTimer) clearTimeout(registration.flushTimer);
    registration.flushTimer = null;
  }

  #releaseAnswered(event: AgentEvent): void {
    const answered =
      event.type === "agent-input-resolved" || event.type === "browser-takeover-resolved"
        ? { agentId: event.agentId, requestId: event.requestId }
        : null;
    if (!answered) return;
    for (const registration of this.#registrations.values()) {
      registration.held = registration.held.filter(({ event: held }) => !sameRequest(heldRequest(held), answered));
      registration.waiting = registration.waiting.filter(({ event }) => !sameRequest(heldRequest(event), answered));
    }
  }

  #scheduleFlush(registration: Registration): void {
    if (!registration.held.length || registration.flushTimer) return;
    registration.flushTimer = setTimeout(() => {
      registration.flushTimer = null;
      if (this.#registrations.get(registration.stored.sessionId) !== registration) return;
      Effect.runFork(this.#flush(registration).pipe(Effect.forkIn(this.#scope, { startImmediately: true })));
    }, HELD_FLUSH_DELAY_MS);
  }

  #flush = Effect.fn("PushNotifications.flush")(function* (this: PushNotificationService, registration: Registration) {
    const { value, memberId } = registration.stored;
    if (!value.away && registration.connected) return;
    const now = this.#now();
    const held = registration.held.filter((item) => now - item.at < HELD_EVENT_MS);
    registration.held = [];
    if (!held.length) return;
    const snapshot = this.#options.agents.getRuntimeSnapshot();
    const reads = this.#options.agents.listConversationReads(
      memberId,
      markerExclusionsForCapabilities(registration.capabilities),
    );
    const agents = this.#options.agents.listAgents();
    const sawScreen = registration.connected;
    for (const { event } of held) {
      const unseen = heldEventUnseen(event, snapshot, reads, agents);
      if (unseen === false || (unseen === null && sawScreen)) continue;
      yield* this.#deliver(event, registration);
    }
  });

  #save(): void {
    const registrations = [...this.#registrations.values()].map((registration) => registration.stored);
    const save = Effect.runFork(
      this.#options.store
        .replace(registrations)
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              this.#options.logger?.warn("Push notification phones were not saved:", toLogValue(error.cause)),
            ),
          ),
        ),
    );
    this.#saves.add(save);
    save.addObserver(() => this.#saves.delete(save));
  }

  #listen(): void {
    if (this.#listening) return;
    this.#options.agents.on("event", this.#listener);
    this.#options.signInWaits?.on("signInWait", this.#signInListener);
    this.#listening = true;
  }
}

function soundOf(value: StoredPushRegistration["value"]): NotificationSound | null {
  return value.sound === "none" ? null : value.sound;
}

function relayRequest(
  stored: StoredPushRegistration,
  sealed: string,
  timestamp: number,
): NotificationRelayRequest | null {
  const { sessionId, value } = stored;
  const sound = soundOf(value);
  if (stored.platform === "android") {
    return { platform: "android", push: { token: stored.value.token, sessionId, sealed, sound, timestamp } };
  }
  const { token, environment } = stored.value;
  return token === null ? null : { platform: "ios", push: { token, environment, sessionId, sealed, sound, timestamp } };
}

function heldEventUnseen(
  event: PushNotice,
  snapshot: ReturnType<PushNotificationAgents["getRuntimeSnapshot"]>,
  reads: ReturnType<PushNotificationAgents["listConversationReads"]>,
  agents: readonly AgentSummary[],
): boolean | null {
  if (event.type === "error" || event.type === "thread-turn-completed") return null;
  if (event.type === "provider-sign-in-wait") return true;
  if (event.type !== "turn-completed") return true;
  if (event.status !== "completed") {
    return snapshot.failedTurns.some((failed) => failed.agentId === event.agentId && failed.turnId === event.turnId);
  }
  if (agents.find((agent) => agent.id === event.agentId)?.threadId !== event.threadId) return null;
  return (reads[event.agentId]?.unreadCount ?? 0) > 0;
}

type EndedSubagentsEvent = Extract<AgentEvent, { type: "subagents-ended" }>;

function mergeEnded(kept: EndedSubagentsEvent, next: EndedSubagentsEvent): EndedSubagentsEvent {
  const subagents = new Map(kept.subagents.map((subagent) => [subagent.id, subagent] as const));
  for (const subagent of next.subagents) subagents.set(subagent.id, subagent);
  return { ...next, subagents: [...subagents.values()].slice(-100), running: next.running };
}

const GOAL_REPLY = "fork-goal-reply";

function goalWaitsForUser(event: AgentEvent): boolean {
  return event.type === "turn-completed" && forkHub.goals?.get(event.agentId)?.state === "paused";
}

function heldRequest(event: PushNotice): { agentId: string; requestId: string | number } | null {
  switch (event.type) {
    case "prompt":
      return { agentId: event.agentId, requestId: event.requestId };
    case "approval":
      return { agentId: event.approval.agentId, requestId: event.approval.requestId };
    case "browser-takeover-requested":
      return { agentId: event.request.agentId, requestId: event.request.requestId };
    default:
      return null;
  }
}

function sameRequest(
  request: { agentId: string; requestId: string | number } | null,
  other: { agentId: string; requestId: string | number },
): boolean {
  return request !== null && request.agentId === other.agentId && request.requestId === other.requestId;
}

function requestStillWaits(
  event: AgentEvent,
  snapshot: ReturnType<PushNotificationAgents["getRuntimeSnapshot"]>,
): boolean {
  if (event.type === "subagents-ended") return true;
  const request = heldRequest(event);
  if (!request) return goalWaitsForUser(event);
  const pending = [...snapshot.pendingPrompts, ...snapshot.pendingApprovals, ...snapshot.pendingBrowserTakeovers];
  return pending.some((item) => sameRequest(item, request)) || !snapshot.attentionComplete;
}

function eventSubject(event: AgentEvent, sideThread: boolean): PushNotificationSubject | null {
  // Fork: subagents that ended after their turn. Only the phone notifies about them.
  if (event.type === "subagents-ended")
    return {
      agentId: event.agentId,
      kind: event.subagents.some((subagent) => subagent.status === "failed") ? "failed" : "reply",
    };
  if (!agentEventCanNotify(event)) return null;
  switch (event.type) {
    case "turn-completed":
      return { agentId: event.agentId, kind: event.status === "completed" ? "reply" : "failed", sideThread };
    case "prompt":
      return { agentId: event.agentId, kind: "input" };
    case "approval":
      return { agentId: event.approval.agentId, kind: "approval" };
    case "browser-takeover-requested":
      return { agentId: event.request.agentId, kind: "browser" };
    case "error":
      return event.agentId ? { agentId: event.agentId, kind: "failed" } : null;
    default:
      return null;
  }
}

export class PushNotificationSendFailure extends Schema.TaggedError<PushNotificationSendFailure>()(
  "PushNotificationSendFailure",
  { cause: Schema.Defect() },
) {}
