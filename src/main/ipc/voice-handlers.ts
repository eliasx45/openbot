// The speech recognition models (Parakeet and Whisper turbo on this computer, ElevenLabs Scribe in
// the cloud), their settings, and dictation. Also the speech model that reads replies aloud, and the
// user's own OpenAI-compatible voice server, which can take either route.

import type {
  DraftAttachment,
  SpeechAudio,
  SpeechModelStatus,
  SpeechSettings,
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
import { sourceText } from "@openbot/i18n/source";
import type { WebContents } from "electron";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { forkHub } from "../../backend/fork-hub";
import type { VoiceServerService } from "../voice-server-service";
import type { VoiceSpeechService } from "../voice-speech-service";
import type { VoiceTranscriptionService } from "../voice-transcription-service";
import { eventPayloadHandler, handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import {
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
  /** The user's own server. While one of its routes is on, it replaces the model on this computer. */
  server: VoiceServerService;
  /** Keeps a voice turn's recording as an attachment draft. Voice turns go to this computer's host only. */
  service: Pick<
    AgentService,
    "prepareVoiceRecording" | "startLiveVoice" | "stopLiveVoice" | "previewLiveVoice" | "speakLiveVoice"
  >;
}

export function voiceIpcHandlers({
  voice,
  speech,
  server,
  service,
}: VoiceIpcDependencies): Pick<IpcGroupHandlers, "voice"> {
  // A window that closes, reloads or crashes cannot stop its live voice any more, so main stops it.
  const liveSessions = new WeakMap<WebContents, Set<string>>();
  const stopLiveSessions = (owner: WebContents) => {
    const sessions = liveSessions.get(owner);
    if (!sessions) return;
    for (const sessionId of sessions) void runCauseEffect(service.stopLiveVoice(sessionId)).catch(() => undefined);
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
      // The server's model is ready on the server: nothing on this computer is downloaded for it.
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
      setApiKey: payloadHandler(
        parseVoiceApiKey,
        ({ key }): Promise<VoiceModelStatus> => runCauseEffect(voice.setApiKey(key)),
      ),
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
      // A server has nothing to load on this computer.
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
      // Codex live voice: Codex App Server answers the renderer's WebRTC offer with the user's own
      // Codex sign-in. Main never sees the audio or the credentials.
      startLive: eventPayloadHandler(parseVoiceLiveStart, async (event, input): Promise<VoiceLiveSession> => {
        // The opt-in is checked here, because the voice goes to OpenAI only while it is on.
        const { codexLive, codexLiveVoice } = speech.getSettings();
        if (!codexLive) throw new Error(sourceText("error.voice.live.off"));
        const session = await runCauseEffect(service.startLiveVoice(input, codexLiveVoice));
        if (event.sender.isDestroyed()) {
          await runCauseEffect(service.stopLiveVoice(session.sessionId));
          throw new Error(sourceText("error.voice.live.disconnected"));
        }
        watchLiveOwner(event.sender, session.sessionId);
        return session;
      }),
      stopLive: eventPayloadHandler(parseVoiceLiveStop, ({ sender }, { sessionId }): Promise<void> => {
        liveSessions.get(sender)?.delete(sessionId);
        return runCauseEffect(service.stopLiveVoice(sessionId));
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
