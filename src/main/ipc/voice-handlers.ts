import type {
  DraftAttachment,
  SpeechAudio,
  SpeechModelStatus,
  SpeechSettings,
  VoiceLiveEvent,
  VoiceLiveSession,
  VoiceModelStatus,
  VoiceNoteSample,
  VoiceNoteSettings,
  VoiceServerProbe,
  VoiceServerSettings,
  VoiceSettings,
  VoiceStream,
  VoiceTranscriptionResult,
} from "@openbot/contracts/ipc";
import {
  decodeLiveVoiceSessionResponse,
  isLiveVoiceName,
  LIVE_VOICE_CAPABILITY,
  LIVE_VOICE_ROUTES,
} from "@openbot/contracts/team-protocol/live-voice-v1";
import { sourceText } from "@openbot/i18n/source";
import type { WebContents } from "electron";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { forkHub } from "../../backend/fork-hub";
import { liveVoiceOf } from "../live-voice-choice";
import { acceptEmpty } from "../remote-host-decoding";
import type { RemoteServerManager } from "../remote-server-manager";
import { voiceLiveEventFromWire } from "../team-api/route-live-voice";
import type { VoiceServerService } from "../voice-server-service";
import type { VoiceSpeechService } from "../voice-speech-service";
import type { VoiceTranscriptionService } from "../voice-transcription-service";
import { agentRequest } from "./agent-inputs";
import { eventPayloadHandler, handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { routeToServer } from "./route-to-server";
import {
  parseSpeechApiKey,
  parseSpeechInput,
  parseSpeechSettings,
  parseVoiceApiKey,
  parseVoiceLivePreview,
  parseVoiceLiveSpeak,
  parseVoiceLiveStart,
  parseVoiceLiveStop,
  parseVoiceModelRequest,
  parseVoiceNotePreview,
  parseVoiceNoteVoice,
  parseVoiceRecording,
  parseVoiceServerConnection,
  parseVoiceServerSave,
  parseVoiceSettings,
  parseVoiceStream,
  parseVoiceStreamAudio,
  parseVoiceTranscription,
} from "./voice-inputs";

export interface VoiceIpcDependencies {
  voice: VoiceTranscriptionService;
  speech: VoiceSpeechService;
  server: VoiceServerService;
  service: Pick<
    AgentService,
    "prepareVoiceRecording" | "startLiveVoice" | "stopLiveVoice" | "previewLiveVoice" | "speakLiveVoice"
  >;
  remoteServers: Pick<RemoteServerManager, "request" | "supportsCapability" | "on">;
  forwardLiveEvent(event: VoiceLiveEvent): void;
}

const REMOTE_LIVE_START_TIMEOUT_MS = 60_000;

export function voiceIpcHandlers({
  voice,
  speech,
  server,
  service,
  remoteServers,
  forwardLiveEvent,
}: VoiceIpcDependencies): Pick<IpcGroupHandlers, "voice"> {
  const liveSessions = new WeakMap<WebContents, Set<string>>();
  const remoteSessions = new Map<string, string>();
  const stopLive = (sessionId: string): Promise<void> => {
    const serverId = remoteSessions.get(sessionId);
    if (serverId === undefined) return runCauseEffect(service.stopLiveVoice(sessionId));
    remoteSessions.delete(sessionId);
    return runCauseEffect(
      remoteServers.request(serverId, LIVE_VOICE_ROUTES.stop, acceptEmpty, {
        method: "POST",
        body: { sessionId },
      }),
    );
  };
  remoteServers.on("liveVoice", (_serverId, event) => {
    if (event.kind === "ended") remoteSessions.delete(event.sessionId);
    forwardLiveEvent(voiceLiveEventFromWire(event));
  });
  remoteServers.on("changed", (servers) => {
    const online = new Set(servers.filter((summary) => summary.state === "online").map(({ id }) => id));
    for (const [sessionId, serverId] of remoteSessions)
      if (!online.has(serverId)) {
        void stopLive(sessionId).catch(() => undefined);
        forwardLiveEvent({ type: "ended", sessionId, error: null });
      }
  });
  const stopLiveSessions = (owner: WebContents) => {
    const sessions = liveSessions.get(owner);
    if (!sessions) return;
    for (const sessionId of sessions) void stopLive(sessionId).catch(() => undefined);
    sessions.clear();
  };
  const watchLiveOwner = (owner: WebContents, sessionId: string) => {
    const sessions = liveSessions.get(owner);
    if (sessions) {
      sessions.add(sessionId);
      return;
    }
    liveSessions.set(owner, new Set([sessionId]));
    owner.once("destroyed", () => stopLiveSessions(owner));
    owner.on("render-process-gone", () => stopLiveSessions(owner));
    owner.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) stopLiveSessions(owner);
    });
  };
  return {
    voice: {
      getModelStatus: handler((): Promise<VoiceModelStatus> => runCauseEffect(voice.getModelStatus())),
      getModelStatuses: handler((): Promise<VoiceModelStatus[]> => runCauseEffect(voice.getModelStatuses())),
      prepareModel: handler(
        (): Promise<VoiceModelStatus> =>
          server.dictates()
            ? Promise.resolve({ modelId: voice.getSettings().modelId, phase: "ready", progress: 100, message: null })
            : runCauseEffect(voice.prepareModel()),
      ),
      downloadModel: payloadHandler(
        parseVoiceModelRequest,
        ({ modelId }): Promise<VoiceModelStatus> => runCauseEffect(voice.downloadModel(modelId)),
      ),
      cancelModelDownload: payloadHandler(
        parseVoiceModelRequest,
        ({ modelId }): Promise<VoiceModelStatus> => runCauseEffect(voice.cancelModelDownload(modelId)),
      ),
      removeModel: payloadHandler(
        parseVoiceModelRequest,
        ({ modelId }): Promise<VoiceModelStatus> => runCauseEffect(voice.removeModel(modelId)),
      ),
      getSettings: handler((): VoiceSettings => voice.getSettings()),
      setSettings: payloadHandler(
        parseVoiceSettings,
        (settings): Promise<VoiceSettings> => runCauseEffect(voice.setSettings(settings)),
      ),
      transcribe: payloadHandler(
        parseVoiceTranscription,
        ({ audio }): Promise<VoiceTranscriptionResult> =>
          runCauseEffect(
            server.dictates() ? server.transcribe(audio, voice.getSettings().language) : voice.transcribe(audio),
          ),
      ),
      setApiKey: payloadHandler(parseVoiceApiKey, async ({ provider, key }): Promise<VoiceModelStatus> => {
        const status = await runCauseEffect(voice.setApiKey(provider, key));
        if (provider === "elevenlabs") await runCauseEffect(speech.announceStatus());
        return status;
      }),
      startStream: handler((): Promise<VoiceStream> => runCauseEffect(voice.startStream())),
      appendStream: payloadHandler(
        parseVoiceStreamAudio,
        (audio): Promise<void> => runCauseEffect(voice.appendStream(audio)),
      ),
      finishStream: payloadHandler(
        parseVoiceStream,
        (stream): Promise<VoiceTranscriptionResult> => runCauseEffect(voice.finishStream(stream)),
      ),
      cancelStream: payloadHandler(parseVoiceStream, (stream): void => voice.cancelStream(stream)),
      getSpeechSettings: handler((): SpeechSettings => speech.getSettings()),
      setSpeechSettings: payloadHandler(
        parseSpeechSettings,
        (settings): Promise<SpeechSettings> => runCauseEffect(speech.setSettings(settings)),
      ),
      getSpeechModelStatus: handler((): Promise<SpeechModelStatus> => runCauseEffect(speech.getModelStatus())),
      setSpeechApiKey: payloadHandler(parseSpeechApiKey, async ({ provider, key }): Promise<SpeechModelStatus> => {
        if (provider === "xai") return runCauseEffect(speech.setXaiApiKey(key));
        await runCauseEffect(voice.setApiKey("elevenlabs", key));
        return runCauseEffect(speech.announceStatus());
      }),
      downloadSpeechModel: handler((): Promise<SpeechModelStatus> => runCauseEffect(speech.downloadModel())),
      cancelSpeechModelDownload: handler(
        (): Promise<SpeechModelStatus> => runCauseEffect(speech.cancelModelDownload()),
      ),
      removeSpeechModel: handler((): Promise<SpeechModelStatus> => runCauseEffect(speech.removeModel())),
      speak: payloadHandler(
        parseSpeechInput,
        (input): Promise<SpeechAudio> =>
          runCauseEffect(server.speaks() ? server.speak(input.text) : speech.speak(input)),
      ),
      warmSpeech: handler((): Promise<void> => (server.speaks() ? Promise.resolve() : runCauseEffect(speech.warm()))),
      keepRecording: payloadHandler(parseVoiceRecording, async ({ audio }): Promise<DraftAttachment> => {
        const [draft] = await runCauseEffect(service.prepareVoiceRecording(audio));
        if (!draft) throw new Error(sourceText("error.voice.recordingNotKept"));
        return draft;
      }),
      getServer: handler((): VoiceServerSettings | null => server.get()),
      probeServer: payloadHandler(
        parseVoiceServerConnection,
        (connection): Promise<VoiceServerProbe> => runCauseEffect(server.probe(connection)),
      ),
      setServer: payloadHandler(
        parseVoiceServerSave,
        (save): Promise<VoiceServerSettings | null> => runCauseEffect(server.set(save.server)),
      ),
      startLive: eventPayloadHandler(
        agentRequest(parseVoiceLiveStart),
        async (event, { serverId, payload: input }): Promise<VoiceLiveSession> => {
          const settings = speech.getSettings();
          if (!settings.codexLive) throw new Error(sourceText("error.voice.live.off"));
          const codexLiveVoice = liveVoiceOf(settings);
          const session = await routeToServer(serverId, {
            local: () => runCauseEffect(service.startLiveVoice(input, codexLiveVoice)),
            remote: async (target) => {
              if (!remoteServers.supportsCapability(target, LIVE_VOICE_CAPABILITY))
                throw new Error(sourceText("error.team.liveVoiceUnsupported"));
              const started = await runCauseEffect(
                remoteServers.request(target, LIVE_VOICE_ROUTES.start, decodeLiveVoiceSessionResponse, {
                  method: "POST",
                  body: {
                    agentId: input.agentId,
                    sdp: input.sdp,
                    ...(isLiveVoiceName(codexLiveVoice) ? { voice: codexLiveVoice } : {}),
                  },
                  timeoutMs: REMOTE_LIVE_START_TIMEOUT_MS,
                }),
              );
              remoteSessions.set(started.sessionId, target);
              return started;
            },
          });
          if (event.sender.isDestroyed()) {
            await stopLive(session.sessionId);
            throw new Error(sourceText("error.voice.live.disconnected"));
          }
          watchLiveOwner(event.sender, session.sessionId);
          return session;
        },
      ),
      stopLive: eventPayloadHandler(parseVoiceLiveStop, ({ sender }, { sessionId }): Promise<void> => {
        liveSessions.get(sender)?.delete(sessionId);
        return stopLive(sessionId);
      }),
      // A sample of the voice that Settings picks. Only the sample sentence goes to OpenAI: no microphone.
      previewLive: eventPayloadHandler(parseVoiceLivePreview, async (event, input): Promise<VoiceLiveSession> => {
        if (!speech.getSettings().codexLive) throw new Error(sourceText("error.voice.live.off"));
        const session = await runCauseEffect(service.previewLiveVoice(input));
        if (event.sender.isDestroyed()) {
          await runCauseEffect(service.stopLiveVoice(session.sessionId));
          throw new Error(sourceText("error.voice.live.disconnected"));
        }
        watchLiveOwner(event.sender, session.sessionId);
        return session;
      }),
      speakLive: payloadHandler(
        parseVoiceLiveSpeak,
        ({ sessionId, text }): Promise<void> => runCauseEffect(service.speakLiveVoice(sessionId, text)),
      ),
      // Fork (docs/fork/FEATURES.md, "Voice notes").
      getVoiceNotes: handler((): Promise<VoiceNoteSettings> => runCauseEffect(voiceNotes().settings())),
      setVoiceNoteVoice: payloadHandler(
        parseVoiceNoteVoice,
        (voice): Promise<VoiceNoteSettings> => runCauseEffect(voiceNotes().setVoice(voice)),
      ),
      previewVoiceNote: payloadHandler(
        parseVoiceNotePreview,
        ({ voice, text }): Promise<VoiceNoteSample> => runCauseEffect(voiceNotes().preview(voice, text)),
      ),
    },
  };
}

/** Fork: the voice notes service, which the agent service creates at start. */
function voiceNotes() {
  const notes = forkHub.voiceNotes;
  if (!notes) throw new Error("Voice notes are not ready yet.");
  return notes;
}
