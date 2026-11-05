import type { CodexLiveVoice, OpenBotDesktopApi, VoiceLiveEvent } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createSignal, onCleanup } from "solid-js";

/** The data channel that the realtime model sends its events on. */
const EVENTS_CHANNEL = "oai-events";
/** A sample that has not ended by then is cut: the voice reads one short sentence. */
const SAMPLE_LIMIT_MS = 20_000;
/** The audio of a reply arrives a little after the model says its turn is done. */
const TAIL_MS = 800;

export type LiveVoicePreviewPort = Pick<
  OpenBotDesktopApi["voice"],
  "previewLive" | "speakLive" | "stopLive" | "onLiveEvent"
>;

/** Read on each call: tests and stories replace `window.openbot` per case. */
function livePreviewPort(): LiveVoicePreviewPort {
  return window.openbot.voice;
}

/** Whether a data channel message says that the voice finished its turn. */
function isReplyDone(data: unknown): boolean {
  if (typeof data !== "string") return false;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return false;
  }
  if (typeof event !== "object" || event === null || !("type" in event) || !("turn" in event)) return false;
  const turn = event.turn;
  return (
    event.type === "turn.done" &&
    typeof turn === "object" &&
    turn !== null &&
    "role" in turn &&
    turn.role === "assistant"
  );
}

/**
 * Plays a sample of a Codex live voice in Settings. It opens a call on a thread outside every chat,
 * with no microphone, has the voice read `text` once the call connects, and hangs up when the voice
 * is done. A new sample ends the one before it. It ends with its owner.
 */
export function createLiveVoicePreview(deps: { port?: LiveVoicePreviewPort; onError: (error: unknown) => void }) {
  const port = deps.port ?? livePreviewPort();
  const [playing, setPlaying] = createSignal(false);
  let run = 0;
  let sessionId: string | null = null;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let tail: ReturnType<typeof setTimeout> | undefined;
  const audio = new Audio();
  audio.autoplay = true;

  const stopEvents = port.onLiveEvent((event: VoiceLiveEvent) => {
    if (event.type !== "ended" || event.sessionId !== sessionId) return;
    sessionId = null;
    stop();
    if (event.error) deps.onError(new Error(event.error));
  });

  function stop(): void {
    run += 1;
    if (limit) clearTimeout(limit);
    if (tail) clearTimeout(tail);
    limit = undefined;
    tail = undefined;
    if (sessionId) void port.stopLive({ sessionId }).catch(() => undefined);
    sessionId = null;
    channel?.close();
    channel = undefined;
    peer?.close();
    peer = undefined;
    audio.srcObject = null;
    setPlaying(false);
  }

  async function play(voice: CodexLiveVoice | null, text: string): Promise<void> {
    stop();
    const own = run;
    setPlaying(true);
    let connected = false;
    let spoken = false;
    // The voice reads only once the call carries audio and main knows the session.
    const speak = () => {
      if (spoken || !connected || !sessionId || own !== run) return;
      spoken = true;
      void port.speakLive({ sessionId, text }).catch((error: unknown) => {
        if (own !== run) return;
        stop();
        deps.onError(error);
      });
    };
    try {
      peer = new RTCPeerConnection();
      // The call sends no microphone, but the offer keeps the audio line both ways, as a call has.
      peer.addTransceiver("audio", { direction: "sendrecv" });
      peer.addEventListener("track", (event) => {
        const [stream] = event.streams;
        audio.srcObject = stream ?? new MediaStream([event.track]);
      });
      channel = peer.createDataChannel(EVENTS_CHANNEL);
      channel.addEventListener("open", () => {
        connected = true;
        speak();
      });
      channel.addEventListener("message", (event) => {
        if (!isReplyDone(event.data) || own !== run) return;
        if (tail) clearTimeout(tail);
        tail = setTimeout(() => {
          if (own === run) stop();
        }, TAIL_MS);
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) throw new Error(currentText().t("conversation.voice.error"));
      const session = await port.previewLive({ sdp: offer.sdp, voice });
      if (own !== run) {
        void port.stopLive({ sessionId: session.sessionId }).catch(() => undefined);
        return;
      }
      sessionId = session.sessionId;
      await peer.setRemoteDescription({ type: "answer", sdp: session.sdp });
      limit = setTimeout(() => {
        if (own === run) stop();
      }, SAMPLE_LIMIT_MS);
      speak();
    } catch (error) {
      if (own !== run) return;
      stop();
      deps.onError(error);
    }
  }

  onCleanup(() => {
    stop();
    stopEvents();
  });

  return {
    playing,
    play,
    stop,
    toggle(voice: CodexLiveVoice | null, text: string): void {
      if (playing()) stop();
      else void play(voice, text);
    },
  };
}
