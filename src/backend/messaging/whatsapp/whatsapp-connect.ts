import { randomUUID } from "node:crypto";
import type {
  StartWhatsAppLinkInput,
  WhatsAppAccount,
  WhatsAppGroupList,
  WhatsAppLinkState,
  WhatsAppSender,
  WhatsAppWatchPlacement,
} from "@openbot/contracts/ipc";
import { DEFAULT_WHATSAPP_WATCH_PLACEMENT, isWhatsAppWatchPlacement, MESSAGING_LIMITS } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { newStoreKey } from "@openbot/whatsapp/auth-store";
import { Effect, Schema } from "effect";
import type { MessagingHistoryStore } from "../messaging-history-store";
import type { MessagingCredentials, MessagingOperationFailed } from "../messaging-service";
import type { MessagingStore } from "../messaging-store";
import type { WhatsAppHistory } from "./whatsapp-archive";
import { maskedNumber, whatsAppCredentials, whatsAppIdentity } from "./whatsapp-driver";
import { userJid } from "./whatsapp-events";
import type { WhatsAppConnectionHandle, WhatsAppPolicy, WhatsAppRuntime } from "./whatsapp-runtime";
import { WhatsAppPairingRequests, type WhatsAppSenderRules, whatsAppNumberForms } from "./whatsapp-senders";

export class WhatsAppConnectFailed extends Schema.TaggedError<WhatsAppConnectFailed>()("WhatsAppConnectFailed", {
  cause: Schema.Defect(),
}) {}

const LINK_TIMEOUT_MS = 3 * 60_000;
const REGISTERED_NUMBER_TIMEOUT_MS = 5_000;

const IDLE: WhatsAppLinkState = { status: "idle", qr: null, code: null, workspaceId: null, error: null };

export interface WhatsAppConnectHooks {
  prepare(workspaceId: string, workspaceName: string): Effect.Effect<string, MessagingOperationFailed>;
  finish(connectionId: string, values: Record<string, string>): Effect.Effect<void, MessagingOperationFailed>;
  dispatch(operation: Effect.Effect<void, MessagingOperationFailed>): void;
}

export interface WhatsAppConnectOptions {
  runtime: WhatsAppRuntime;
  store: MessagingStore;
  history: MessagingHistoryStore;
  credentials: MessagingCredentials;
  hooks: WhatsAppConnectHooks;
}

interface RunningLink {
  storeId: string;
  handle: WhatsAppConnectionHandle;
  timer: ReturnType<typeof setTimeout>;
  unsubscribe: Array<() => void>;
  finishing: boolean;
}

export class WhatsAppConnect implements WhatsAppPolicy {
  readonly #runtime: WhatsAppRuntime;
  readonly #store: MessagingStore;
  readonly #history: MessagingHistoryStore;
  readonly #credentials: MessagingCredentials;
  readonly #hooks: WhatsAppConnectHooks;
  readonly #requests = new WhatsAppPairingRequests();
  #link: RunningLink | null = null;
  #state: WhatsAppLinkState = IDLE;

  constructor(options: WhatsAppConnectOptions) {
    this.#runtime = options.runtime;
    this.#store = options.store;
    this.#history = options.history;
    this.#credentials = options.credentials;
    this.#hooks = options.hooks;
    this.#runtime.setPolicy(this);
  }

  linkState(): WhatsAppLinkState {
    return this.#state;
  }

  readonly startLink = Effect.fn("WhatsAppConnect.startLink")(function* (
    this: WhatsAppConnect,
    input: StartWhatsAppLinkInput,
  ) {
    yield* this.cancelLink();
    const storeId = `link-${randomUUID()}`;
    const key = newStoreKey();
    let handle: WhatsAppConnectionHandle;
    try {
      handle = this.#runtime.open(storeId, key, true);
    } catch {
      this.#state = { ...IDLE, status: "failed", error: "unavailable" };
      return this.#state;
    }
    const timer = setTimeout(() => this.#hooks.dispatch(this.#fail(link, "timeout")), LINK_TIMEOUT_MS);
    timer.unref?.();
    const link: RunningLink = { storeId, handle, timer, unsubscribe: [], finishing: false };
    this.#link = link;
    this.#state = { ...IDLE, status: "waiting" };
    let codeRequested = false;
    link.unsubscribe.push(
      handle.session.onQr((qr) => {
        if (this.#link !== link) return;
        if (input.method === "qr") {
          this.#state = { ...this.#state, qr };
          return;
        }
        if (codeRequested || !input.phoneNumber) return;
        codeRequested = true;
        this.#hooks.dispatch(
          handle.session.requestPairingCode(input.phoneNumber).pipe(
            Effect.flatMap((code) =>
              Effect.sync(() => {
                if (this.#link === link)
                  this.#state = { ...this.#state, code: code.replace(/[^A-Z0-9]/giu, "").toUpperCase() };
              }),
            ),
            Effect.catch(() => this.#fail(link, "refused")),
          ),
        );
      }),
      handle.session.onState((state) => {
        if (this.#link !== link) return;
        if (state === "open" && handle.store.linked) this.#hooks.dispatch(this.#finish(link, key, input.ownNumber));
        else if (state === "logged_out" || state === "replaced") this.#hooks.dispatch(this.#fail(link, "refused"));
        else if (state === "unreachable") this.#hooks.dispatch(this.#fail(link, "unavailable"));
        else if (state === "stopped" && !link.finishing) this.#hooks.dispatch(this.#fail(link, "timeout"));
      }),
    );
    handle.session.start({ codeLink: input.method === "code" });
    return this.#state;
  });

  readonly cancelLink = Effect.fn("WhatsAppConnect.cancelLink")(function* (this: WhatsAppConnect) {
    const link = this.#link;
    if (!link || link.finishing) return;
    yield* this.#end(link, true);
    this.#state = IDLE;
  });

  rules(workspaceId: string): WhatsAppSenderRules {
    const record = this.#store.connectionForWorkspace("whatsapp", workspaceId);
    if (!record) return { ownNumber: true, contacts: new Map(), groups: new Set() };
    const senders = this.#store.allowedSenders(record.connectionId);
    return {
      ownNumber: this.#ownNumber(record.connectionId),
      contacts: new Map(
        senders.filter((sender) => sender.kind === "contact").map((sender) => [sender.id, savedName(sender.name)]),
      ),
      groups: new Set(senders.filter((sender) => sender.kind === "group").map((sender) => sender.id)),
      // Fork (#68).
      watched: new Map(this.#watched(record.connectionId).map((sender) => [sender.id, sender.name])),
    };
  }

  pairing(workspaceId: string, senderId: string, name: string): { code: string; created: boolean } | null {
    const record = this.#store.connectionForWorkspace("whatsapp", workspaceId);
    if (!record?.enabled || this.#ownNumber(record.connectionId)) return null;
    return this.#requests.request(workspaceId, senderId, name);
  }

  history(workspaceId: string): WhatsAppHistory | null {
    const record = this.#store.connectionForWorkspace("whatsapp", workspaceId);
    return record ? { connectionId: record.connectionId, store: this.#history } : null;
  }

  accounts(): WhatsAppAccount[] {
    return this.#store
      .connections()
      .filter((record) => record.platform === "whatsapp" && this.#credentials.status(record.connectionId) !== "missing")
      .map((record) => ({
        workspaceId: record.workspaceId,
        ownNumber: this.#ownNumber(record.connectionId),
        workingMessage: this.workingMessage(record.connectionId),
        watchPlacement: this.watchPlacement(record.connectionId),
        statusReactions: this.statusReactions(record.connectionId),
        allowedSenders: this.#store.allowedSenders(record.connectionId).slice(0, MESSAGING_LIMITS.allowedSenders),
        watched: this.#watched(record.connectionId).map((sender) => ({ ...sender, kind: "watch" as const })),
        pendingRequests: this.#requests.list(record.workspaceId),
      }));
  }

  readonly addSender = Effect.fn("WhatsAppConnect.addSender")(function* (
    this: WhatsAppConnect,
    workspaceId: string,
    sender: WhatsAppSender,
  ) {
    yield* this.#allowSender(workspaceId, sender, true);
  });

  #allowSender(
    workspaceId: string,
    sender: WhatsAppSender,
    typed: boolean,
  ): Effect.Effect<void, WhatsAppConnectFailed | MessagingOperationFailed> {
    return Effect.gen({ self: this }, function* () {
      const connectionId = yield* this.#connectionId(workspaceId);
      const id = sender.kind === "group" ? sender.id : yield* this.#registeredNumber(connectionId, sender.id, typed);
      // Fork (#68): a watched contact is read silently and never written to, so it is never also allowed.
      if (sender.kind === "watch") {
        const others = this.#watched(connectionId).filter((watched) => watched.id !== id);
        if (others.length >= MESSAGING_LIMITS.allowedSenders)
          return yield* failure("error.messaging.whatsappTooManySenders");
        yield* this.#setWatched(connectionId, [...others, { id, name: sender.name }]);
        for (const form of whatsAppNumberForms(id)) this.#store.removeAllowedSender(connectionId, form);
        return;
      }
      if (this.#store.allowedSenders(connectionId).length >= MESSAGING_LIMITS.allowedSenders)
        return yield* failure("error.messaging.whatsappTooManySenders");
      if (sender.kind === "contact") {
        const forms = whatsAppNumberForms(id);
        const watched = this.#watched(connectionId);
        if (watched.some((entry) => forms.includes(entry.id)))
          yield* this.#setWatched(
            connectionId,
            watched.filter((entry) => !forms.includes(entry.id)),
          );
      }
      this.#store.addAllowedSender(connectionId, { ...sender, id, kind: sender.kind });
    });
  }

  #registeredNumber(
    connectionId: string,
    number: string,
    typed: boolean,
  ): Effect.Effect<string, WhatsAppConnectFailed> {
    const session = this.#handle(connectionId)?.session;
    const forms = whatsAppNumberForms(number);
    if (!session || (!typed && forms.length === 1)) return Effect.succeed(number);
    return session.registered(forms).pipe(
      Effect.map((jids) => {
        if (!jids) return number;
        const form = forms.find((candidate) => jids.includes(userJid(candidate)));
        return form ?? (typed && jids.length === 0 ? null : number);
      }),
      Effect.timeoutOrElse({ duration: REGISTERED_NUMBER_TIMEOUT_MS, orElse: () => Effect.succeed(number) }),
      Effect.catch(() => Effect.succeed(number)),
      Effect.flatMap((form) =>
        form === null ? failure("error.messaging.whatsappNumberNotFound") : Effect.succeed(form),
      ),
    );
  }

  readonly removeSender = Effect.fn("WhatsAppConnect.removeSender")(function* (
    this: WhatsAppConnect,
    workspaceId: string,
    senderId: string,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    this.#store.removeAllowedSender(connectionId, senderId);
    const watched = this.#watched(connectionId);
    if (watched.some((entry) => entry.id === senderId))
      yield* this.#setWatched(
        connectionId,
        watched.filter((entry) => entry.id !== senderId),
      );
  });

  readonly answerRequest = Effect.fn("WhatsAppConnect.answerRequest")(function* (
    this: WhatsAppConnect,
    workspaceId: string,
    code: string,
    approve: boolean,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    const request = this.#requests.take(workspaceId, code);
    if (!request) return yield* failure("error.messaging.whatsappRequestEnded");
    if (!approve) return;
    yield* this.#allowSender(workspaceId, { id: request.senderId, kind: "contact", name: request.name }, false);
    const handle = this.#handle(connectionId);
    if (handle)
      yield* handle.session
        .send(userJid(request.senderId), { text: sourceText("status.messaging.whatsappPairingApproved") })
        .pipe(Effect.catch(() => Effect.void));
  });

  readonly setOwnNumber = Effect.fn("WhatsAppConnect.setOwnNumber")(function* (
    this: WhatsAppConnect,
    workspaceId: string,
    ownNumber: boolean,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    const values = this.#credentials.get(connectionId);
    if (!values) return yield* failure("error.messaging.whatsappNotConnected");
    yield* this.#credentials.set(connectionId, { ...values, ownNumber: ownNumber ? "1" : "0" });
    if (ownNumber) this.#requests.clear(workspaceId);
  });

  readonly setWorkingMessage = Effect.fn("WhatsAppConnect.setWorkingMessage")(function* (
    this: WhatsAppConnect,
    workspaceId: string,
    workingMessage: boolean,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    const values = this.#credentials.get(connectionId);
    if (!values) return yield* failure("error.messaging.whatsappNotConnected");
    yield* this.#credentials.set(connectionId, { ...values, workingMessage: workingMessage ? "1" : "0" });
  });

  /** Fork (#76): where the "Message yourself" chat, with the watched chats' turns, shows in OpenBot. */
  readonly setWatchPlacement = Effect.fn("WhatsAppConnect.setWatchPlacement")(function* (
    this: WhatsAppConnect,
    workspaceId: string,
    placement: WhatsAppWatchPlacement,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    const values = this.#credentials.get(connectionId);
    if (!values) return yield* failure("error.messaging.whatsappNotConnected");
    yield* this.#credentials.set(connectionId, { ...values, watchPlacement: placement });
  });

  /** Fork (#76): the names of the watched contacts, for the title of their side thread. */
  watchedNames(connectionId: string): string[] {
    return this.#watched(connectionId).map((sender) => sender.name);
  }

  /** Fork (#76): the placement of a number, `main` when the owner never chose one. */
  watchPlacement(connectionId: string): WhatsAppWatchPlacement {
    return watchPlacementOf(this.#credentials.get(connectionId)?.watchPlacement);
  }

  /**
   * Fork (#76): true once for a number, the first time its watched chats show in the orchestrator's own
   * chat, so that orchestrator gets its default notification level once and a later choice stays.
   */
  readonly takeWatchNotificationDefault = Effect.fn("WhatsAppConnect.takeWatchNotificationDefault")(function* (
    this: WhatsAppConnect,
    connectionId: string,
  ) {
    const values = this.#credentials.get(connectionId);
    if (!values || values.watchNotify === "1") return false;
    yield* this.#credentials.set(connectionId, { ...values, watchNotify: "1" });
    return true;
  });

  readonly setStatusReactions = Effect.fn("WhatsAppConnect.setStatusReactions")(function* (
    this: WhatsAppConnect,
    workspaceId: string,
    statusReactions: boolean,
  ) {
    const connectionId = yield* this.#connectionId(workspaceId);
    const values = this.#credentials.get(connectionId);
    if (!values) return yield* failure("error.messaging.whatsappNotConnected");
    yield* this.#credentials.set(connectionId, { ...values, statusReactions: statusReactions ? "1" : "0" });
  });

  readonly groups = Effect.fn("WhatsAppConnect.groups")(function* (this: WhatsAppConnect, workspaceId: string) {
    const connectionId = yield* this.#connectionId(workspaceId);
    const handle = this.#handle(connectionId);
    if (!handle?.session.socket()) return yield* failure("error.messaging.whatsappNotConnected");
    const groups = yield* handle.session
      .groups()
      .pipe(Effect.mapError(() => failureError("error.messaging.whatsappNotConnected")));
    for (const group of groups) handle.chats.rememberGroup(group.id, group.subject);
    const list: WhatsAppGroupList = {
      groups: groups
        .map((group) => ({ id: group.id, name: (group.subject?.trim() || group.id).slice(0, MESSAGING_LIMITS.name) }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MESSAGING_LIMITS.groups),
    };
    return list;
  });

  forget(workspaceId: string): void {
    this.#requests.clear(workspaceId);
  }

  readonly #finish = Effect.fn("WhatsAppConnect.finish")(function* (
    this: WhatsAppConnect,
    link: RunningLink,
    key: Uint8Array,
    ownNumber: boolean,
  ) {
    if (link.finishing || this.#link !== link) return;
    link.finishing = true;
    const identity = whatsAppIdentity(link.handle);
    if (!identity) return yield* this.#fail(link, "refused");
    const name = link.handle.store.creds.me?.name?.trim();
    const workspaceName = name ? `${name} (${maskedNumber(identity.number)})` : maskedNumber(identity.number);
    yield* this.#end(link, false);
    yield* Effect.gen({ self: this }, function* () {
      const connectionId = yield* this.#hooks.prepare(identity.number, workspaceName);
      const earlier = this.#credentials.get(connectionId);
      const previous = earlier?.storeId;
      // Fork (#68): a number linked again keeps its Watch list, as it keeps its allowed senders.
      const watched = earlier?.watched;
      this.#runtime.promote(link.storeId);
      yield* this.#hooks.finish(connectionId, {
        whatsappStoreKey: Buffer.from(key).toString("base64"),
        storeId: link.storeId,
        ownNumber: ownNumber ? "1" : "0",
        ...(watched ? { watched } : {}),
        ...(earlier?.workingMessage === "0" ? { workingMessage: "0" } : {}),
        ...(earlier?.statusReactions === "0" ? { statusReactions: "0" } : {}),
        // Fork (#76): and where its watched chats show.
        ...(earlier?.watchPlacement ? { watchPlacement: earlier.watchPlacement } : {}),
        ...(earlier?.watchNotify ? { watchNotify: earlier.watchNotify } : {}),
      });
      if (previous && previous !== link.storeId) this.#runtime.delete(previous);
    }).pipe(
      Effect.onError(() =>
        Effect.gen({ self: this }, function* () {
          yield* link.handle.session.stop();
          this.#runtime.delete(link.storeId);
          this.#state = { ...IDLE, status: "failed", error: "unavailable" };
        }),
      ),
    );
    this.#state = { ...IDLE, status: "linked", workspaceId: identity.number };
    this.#hooks.dispatch(
      link.handle.session
        .send(userJid(identity.number), {
          text: sourceText(
            ownNumber ? "status.messaging.whatsappWelcomeOwn" : "status.messaging.whatsappWelcomeDedicated",
          ),
        })
        .pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        ),
    );
  });

  #fail(link: RunningLink, error: NonNullable<WhatsAppLinkState["error"]>): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.#link !== link) return;
      yield* this.#end(link, true);
      this.#state = { ...IDLE, status: "failed", error };
    });
  }

  #end(link: RunningLink, discard: boolean): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.#link === link) this.#link = null;
      clearTimeout(link.timer);
      for (const unsubscribe of link.unsubscribe.splice(0)) unsubscribe();
      if (!discard) return;
      yield* link.handle.session.stop();
      this.#runtime.delete(link.storeId);
    });
  }

  #handle(connectionId: string): WhatsAppConnectionHandle | null {
    const storeId = this.#credentials.get(connectionId)?.storeId;
    return storeId ? this.#runtime.get(storeId) : null;
  }

  /**
   * Fork (#68): the watched contacts, kept in the connection's encrypted values beside `ownNumber`, as
   * JSON. Not a table: the allowed-senders table only takes contacts and groups, and a new table would
   * need a numbered migration, which upstream owns.
   */
  #watched(connectionId: string): Array<{ id: string; name: string }> {
    return parseWatched(this.#credentials.get(connectionId)?.watched);
  }

  #setWatched(
    connectionId: string,
    watched: ReadonlyArray<{ id: string; name: string }>,
  ): Effect.Effect<void, WhatsAppConnectFailed | MessagingOperationFailed> {
    return Effect.gen({ self: this }, function* () {
      const values = this.#credentials.get(connectionId);
      if (!values) return yield* failure("error.messaging.whatsappNotConnected");
      yield* this.#credentials.set(connectionId, { ...values, watched: JSON.stringify(watched) });
    });
  }

  #ownNumber(connectionId: string): boolean {
    const values = this.#credentials.get(connectionId);
    return values ? whatsAppCredentials(values).ownNumber : true;
  }

  postsAsOwner(connectionId: string, platformChannelId: string): boolean {
    const record = this.#store.connection(connectionId);
    if (record?.platform !== "whatsapp" || !this.#ownNumber(connectionId)) return false;
    return platformChannelId.split("@")[0] !== record.workspaceId;
  }

  workingMessage(connectionId: string): boolean {
    const values = this.#credentials.get(connectionId);
    return values ? whatsAppCredentials(values).workingMessage : true;
  }

  statusReactions(connectionId: string): boolean {
    const values = this.#credentials.get(connectionId);
    return values ? whatsAppCredentials(values).statusReactions : true;
  }

  #connectionId(workspaceId: string): Effect.Effect<string, WhatsAppConnectFailed> {
    const record = this.#store.connectionForWorkspace("whatsapp", workspaceId);
    return record && this.#credentials.status(record.connectionId) !== "missing"
      ? Effect.succeed(record.connectionId)
      : failure("error.messaging.whatsappNotConnected");
  }
}

/** Fork (#68): the stored Watch list; anything that does not parse is no list. */
function parseWatched(text: string | undefined): Array<{ id: string; name: string }> {
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) =>
      isDynamicRecord(entry) && isString(entry.id) && /^[0-9]{5,20}$/u.test(entry.id) && isString(entry.name)
        ? [{ id: entry.id, name: entry.name.slice(0, MESSAGING_LIMITS.name) || entry.id }]
        : [],
    )
    .slice(0, MESSAGING_LIMITS.allowedSenders);
}

type WhatsAppErrorKey =
  | "error.messaging.whatsappNotConnected"
  | "error.messaging.whatsappTooManySenders"
  | "error.messaging.whatsappNumberNotFound"
  | "error.messaging.whatsappRequestEnded";

function failureError(key: WhatsAppErrorKey): WhatsAppConnectFailed {
  return new WhatsAppConnectFailed({ cause: new Error(sourceText(key)) });
}

function failure(key: WhatsAppErrorKey): Effect.Effect<never, WhatsAppConnectFailed> {
  return Effect.fail(failureError(key));
}

export function watchPlacementOf(value: string | undefined): WhatsAppWatchPlacement {
  return isWhatsAppWatchPlacement(value) ? value : DEFAULT_WHATSAPP_WATCH_PLACEMENT;
}

function savedName(name: string): string {
  const trimmed = name.trim();
  return /^[0-9]+$/u.test(trimmed) ? "" : trimmed;
}
