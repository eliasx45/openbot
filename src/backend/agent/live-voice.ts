import { randomUUID } from "node:crypto";
import type {
  AgentSummary,
  CodexLiveVoice,
  VoiceLiveEvent,
  VoiceLivePreview,
  VoiceLiveSession,
  VoiceLiveStart,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Deferred, Effect, Schema } from "effect";
import type { AgentClient } from "../agent-client";
import { type AppServerNotification, decodeRecordResponse, decodeThreadResponse, getString } from "../protocol";

/** How long Codex has to answer the WebRTC offer of a live voice session. */
const ANSWER_TIMEOUT_MS = 20_000;
/** How Codex reports that OpenAI refused the call: `unexpected status 401 Unauthorized: …`. */
const UNAUTHORIZED = /\bstatus 401\b|\b401 Unauthorized\b/;

class LiveVoiceFailed extends Schema.TaggedError<LiveVoiceFailed>()("LiveVoiceFailed", {
  cause: Schema.Defect(),
}) {}

const liveStep = <A>(run: () => A) => Effect.try({ try: run, catch: (cause) => new LiveVoiceFailed({ cause }) });
const liveFailure = (text: string) => new LiveVoiceFailed({ cause: new Error(text) });

export interface LiveVoiceHooks {
  agent(agentId: string): AgentSummary;
  /** A Codex agent on this computer whose provider can run a voice sample, or undefined when there is none. */
  previewAgent?(): AgentSummary | undefined;
  /** The agent's provider process, started when it is not running. */
  client(agent: AgentSummary): Effect.Effect<AgentClient, { readonly cause: unknown }>;
  /** The provider thread of the agent's chat, made or resumed. */
  ensureThread(agent: AgentSummary, client: AgentClient): Effect.Effect<string, unknown>;
  /** Keeps queued messages of this agent from starting turns until the release. */
  holdDrain(agentId: string): () => void;
  /** Waits for the drains of this agent that started before the hold. */
  awaitDrain(agentId: string): Effect.Effect<void>;
  /** Adds what the user or the voice said to the agent's chat. */
  addSpeech(agentId: string, providerThreadId: string, role: "user" | "assistant", text: string): void;
  emit(event: VoiceLiveEvent): void;
  redact(text: string): string;
}

interface LiveSession {
  readonly id: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly client: AgentClient;
  readonly answer: Deferred.Deferred<string, LiveVoiceFailed>;
  readonly release: () => void;
  readonly onExit: (error: Error) => void;
  /** A voice sample from Settings: its thread is ephemeral and belongs to no chat. */
  readonly preview: boolean;
}

interface LiveOpening {
  readonly agentId: string;
  readonly client: AgentClient;
  readonly threadId: string;
  readonly release: () => void;
  readonly preview: boolean;
}

/**
 * Codex live voice: a realtime voice session on the agent's own Codex thread. The renderer sends a
 * WebRTC offer, and Codex App Server connects it to OpenAI with the user's own Codex sign-in. Audio
 * goes between the renderer and OpenAI. OpenBot never reads the Codex credentials. Turns that the
 * voice model starts run in the agent's chat as usual, so the agent keeps its thread and tools. What the
 * user and the voice say goes into the chat too.
 *
 * One session runs at a time. Queued messages of the agent wait while it runs.
 */
export class LiveVoice {
  readonly #hooks: LiveVoiceHooks;
  readonly #sessions = new Map<string, LiveSession>();
  /** Counts the starts, so that a start that a newer one replaced does not register its session. */
  #starts = 0;

  constructor(hooks: LiveVoiceHooks) {
    this.#hooks = hooks;
  }

  /** Whether a live voice session runs on this provider thread. */
  isLiveThread(threadId: string): boolean {
    return this.#sessionForThread(threadId) !== undefined;
  }

  /** `voice` is the user's choice in Settings; null lets OpenAI choose. */
  readonly start = Effect.fn("LiveVoice.start")(function* (
    this: LiveVoice,
    input: VoiceLiveStart,
    voice: CodexLiveVoice | null,
  ) {
    const agent = yield* liveStep(() => this.#hooks.agent(input.agentId));
    if (agent.provider !== "codex") return yield* liveFailure(sourceText("error.voice.live.codexOnly"));
    for (const session of [...this.#sessions.values()]) yield* this.#stopSession(session);
    const start = ++this.#starts;
    const release = this.#hooks.holdDrain(agent.id);
    const started = yield* Effect.gen({ self: this }, function* () {
      yield* this.#hooks.awaitDrain(agent.id);
      const client = yield* this.#hooks
        .client(agent)
        .pipe(Effect.mapError((failure) => new LiveVoiceFailed({ cause: failure.cause })));
      const threadId = yield* this.#hooks
        .ensureThread(agent, client)
        .pipe(Effect.mapError((cause) => new LiveVoiceFailed({ cause })));
      if (start !== this.#starts) return yield* liveFailure(sourceText("error.voice.live.disconnected"));
      return { client, threadId };
    }).pipe(Effect.onError(() => Effect.sync(release)));

    return yield* this.#open({ agentId: agent.id, ...started, release, preview: false }, input.sdp, voice);
  });

  /**
   * A sample of `voice` for Settings, on an ephemeral thread of a Codex agent's provider. No chat
   * sees it and no microphone joins it: the renderer has the voice read a sentence with `speak`.
   */
  readonly preview = Effect.fn("LiveVoice.preview")(function* (this: LiveVoice, input: VoiceLivePreview) {
    const agent = this.#hooks.previewAgent?.();
    if (!agent) return yield* liveFailure(sourceText("error.voice.live.codexOnly"));
    for (const session of [...this.#sessions.values()]) yield* this.#stopSession(session);
    const start = ++this.#starts;
    const client = yield* this.#hooks
      .client(agent)
      .pipe(Effect.mapError((failure) => new LiveVoiceFailed({ cause: failure.cause })));
    const response = yield* client
      .request(
        "thread/start",
        { ephemeral: true, persistSession: false, sandbox: "read-only", approvalPolicy: "never" },
        decodeThreadResponse,
      )
      .pipe(Effect.mapError((failure) => new LiveVoiceFailed({ cause: failure.cause })));
    const threadId = response.thread.id;
    if (start !== this.#starts) {
      yield* client.request("thread/unsubscribe", { threadId }, decodeRecordResponse).pipe(Effect.ignore);
      return yield* liveFailure(sourceText("error.voice.live.disconnected"));
    }
    return yield* this.#open(
      { agentId: agent.id, client, threadId, release: () => undefined, preview: true },
      input.sdp,
      input.voice,
    );
  });

  /** Has the voice of a session read `text` aloud as it is. */
  readonly speak = Effect.fn("LiveVoice.speak")(function* (this: LiveVoice, sessionId: string, text: string) {
    const session = this.#sessions.get(sessionId);
    if (!session) return yield* liveFailure(sourceText("error.voice.live.disconnected"));
    yield* session.client
      .request("thread/realtime/appendSpeech", { threadId: session.threadId, text }, decodeRecordResponse)
      .pipe(Effect.mapError((failure) => new LiveVoiceFailed({ cause: failure.cause })));
  });

  /** Registers the session and answers the renderer's offer through `thread/realtime/start`. */
  readonly #open = Effect.fn("LiveVoice.open")(function* (
    this: LiveVoice,
    opening: LiveOpening,
    offer: string,
    voice: CodexLiveVoice | null,
  ) {
    const id = randomUUID();
    const session: LiveSession = {
      id,
      ...opening,
      answer: Deferred.makeUnsafe<string, LiveVoiceFailed>(),
      onExit: () => this.#end(session, sourceText("error.voice.live.disconnected")),
    };
    this.#sessions.set(id, session);
    session.client.once("exit", session.onExit);

    const sdp = yield* Effect.gen({ self: this }, function* () {
      yield* session.client
        .request(
          "thread/realtime/start",
          {
            threadId: session.threadId,
            outputModality: "audio",
            transport: { type: "webrtc", sdp: offer },
            // A ChatGPT login reaches only the AVAS calls, which refuse the default v1 protocol.
            version: "v3",
            ...(voice ? { voice } : {}),
            // A sample has no chat to tell the voice about.
            ...(session.preview ? { includeStartupContext: false } : {}),
          },
          decodeRecordResponse,
        )
        .pipe(Effect.mapError((failure) => new LiveVoiceFailed({ cause: failure.cause })));
      return yield* Deferred.await(session.answer).pipe(
        Effect.timeoutOrElse({
          duration: ANSWER_TIMEOUT_MS,
          orElse: () => Effect.fail(liveFailure(sourceText("error.voice.live.timedOut"))),
        }),
      );
    }).pipe(Effect.onError(() => this.#stopSession(session, false)));
    return { sessionId: id, sdp } satisfies VoiceLiveSession;
  });

  readonly stop = Effect.fn("LiveVoice.stop")(function* (this: LiveVoice, sessionId: string) {
    const session = this.#sessions.get(sessionId);
    if (session) yield* this.#stopSession(session);
  });

  /** Takes the `thread/realtime/*` notifications of a live session. */
  handleNotification(notification: AppServerNotification, source: AgentClient): void {
    const threadId = getString(notification.params, "threadId");
    const session = threadId ? this.#sessionForThread(threadId) : undefined;
    if (!session || session.client !== source) return;
    const params = notification.params;
    switch (notification.method) {
      case "thread/realtime/sdp": {
        const sdp = getString(params, "sdp");
        if (sdp) Deferred.doneUnsafe(session.answer, Effect.succeed(sdp));
        return;
      }
      case "thread/realtime/error": {
        this.#end(session, this.#reason(getString(params, "message")));
        return;
      }
      case "thread/realtime/closed": {
        const reason = getString(params, "reason");
        this.#end(session, reason ? this.#reason(reason) : null);
        return;
      }
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done": {
        const role = getString(params, "role");
        if (role !== "user" && role !== "assistant") return;
        const final = notification.method === "thread/realtime/transcript/done";
        const text = getString(params, final ? "text" : "delta");
        if (!text) return;
        this.#hooks.emit({ type: "transcript", sessionId: session.id, role, text, final });
        if (final && text.trim() && !session.preview)
          this.#hooks.addSpeech(session.agentId, session.threadId, role, text);
        return;
      }
    }
  }

  /** Ends every session without a request: the provider clients stop on their own. */
  dispose(): void {
    for (const session of [...this.#sessions.values()]) this.#end(session, null);
  }

  #sessionForThread(threadId: string): LiveSession | undefined {
    for (const session of this.#sessions.values()) if (session.threadId === threadId) return session;
    return undefined;
  }

  #reason(message: string | null): string {
    if (!message) return sourceText("error.voice.live.disconnected");
    // Codex sends an API key login and a missing login to the paid Realtime API, which refuses both.
    if (UNAUTHORIZED.test(message)) return sourceText("error.voice.live.signIn");
    return sourceText("error.voice.live.failed", { reason: this.#hooks.redact(message) });
  }

  readonly #stopSession = Effect.fn("LiveVoice.stopSession")(function* (
    this: LiveVoice,
    session: LiveSession,
    announce = true,
  ) {
    if (!this.#sessions.has(session.id)) return;
    this.#end(session, null, announce);
    yield* session.client
      .request("thread/realtime/stop", { threadId: session.threadId }, decodeRecordResponse)
      .pipe(Effect.ignore);
    // The ephemeral thread of a sample is not needed again.
    if (session.preview)
      yield* session.client
        .request("thread/unsubscribe", { threadId: session.threadId }, decodeRecordResponse)
        .pipe(Effect.ignore);
  });

  #end(session: LiveSession, error: string | null, announce = true): void {
    if (!this.#sessions.delete(session.id)) return;
    session.client.off("exit", session.onExit);
    Deferred.doneUnsafe(session.answer, Effect.fail(liveFailure(error ?? sourceText("error.voice.live.disconnected"))));
    session.release();
    if (announce) this.#hooks.emit({ type: "ended", sessionId: session.id, error });
  }
}
