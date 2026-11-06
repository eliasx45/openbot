/**
 * Fork (docs/fork/FEATURES.md, "Voice notes"): an agent answers with a short spoken message, like a
 * voice memo. `openbot.send_voice_note({ text, language? })` reads the text with the local voice of
 * Settings → Voice (Supertonic 3, the voice that reads replies aloud), encodes it as MP3, and the
 * router attaches the file to the agent's reply with the `attach_files_to_response` gateway. The text
 * stays on this computer. Ported from OpenMausBot's `send_voice_note` (1000 characters, a switch per
 * agent).
 *
 * MP3 is the one audio type that every attachment surface takes (desktop, phone, remote hosts). The
 * encoder is Homebrew's `ffmpeg` or `lame`: OpenBot ships none, and the fork runs on one Mac.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { SPEECH_LANGUAGES, SPEECH_LIMITS, type SpeechAudio, type SpeechInput } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Schema } from "effect";
import { z } from "zod";

export const SEND_VOICE_NOTE_TOOL = "send_voice_note";
const FILE = "fork-voice-notes.json";
/** Where a note is written before the gateway copies it into the attachment store. Inside the shared root. */
const SCRATCH_FOLDER = ".voice-notes";
const ENCODERS = ["ffmpeg", "lame"] as const;
const ENCODER_FOLDERS = ["/opt/homebrew/bin", "/usr/local/bin"];
const BITRATE_KBPS = 64;

export const sendVoiceNoteToolSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(SPEECH_LIMITS.maximumTextLength)
    .describe("The words to speak, as you would say them: plain sentences, no Markdown, links, code or emoji."),
  language: z.enum(SPEECH_LANGUAGES).optional().describe("The language of the text (ISO 639-1). Default en."),
});

/** A voice note that could not be made. The message tells the agent what to do. */
export class VoiceNoteFailed extends Schema.TaggedError<VoiceNoteFailed>()("VoiceNoteFailed", {
  cause: Schema.Defect(),
}) {}

const failed = (message: string) => new VoiceNoteFailed({ cause: new Error(message) });

/** The speech service of Electron main, given to the backend as plain functions. */
export interface ForkVoiceNoteSpeech {
  /** Downloads the voice model when it is missing. Null when it is ready, else why it is not. */
  prepare: () => Effect.Effect<string | null>;
  speak: (input: SpeechInput) => Effect.Effect<SpeechAudio, Error>;
}

interface VoiceNoteState {
  version: 1;
  /** Agents whose voice notes are off. Every other agent may send them. */
  off: string[];
}

export class ForkVoiceNotes {
  readonly #path: string;
  readonly #scratchRoot: string;
  readonly #speech: () => ForkVoiceNoteSpeech | null;
  #state: VoiceNoteState;

  constructor(options: { databasePath: string; sharedRoot: string; speech: () => ForkVoiceNoteSpeech | null }) {
    this.#path = join(dirname(options.databasePath), FILE);
    this.#scratchRoot = join(options.sharedRoot, SCRATCH_FOLDER);
    this.#speech = options.speech;
    this.#state = readState(this.#path);
  }

  enabled(agentId: string): boolean {
    return !this.#state.off.includes(agentId);
  }

  setEnabled(agentId: string, on: boolean): void {
    const off = this.#state.off.filter((id) => id !== agentId);
    this.#state = { version: 1, off: on ? off : [...off, agentId] };
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }

  /**
   * Speaks the text and writes it as an MP3 in a new scratch folder. The caller attaches the file,
   * then calls `discard` with the returned folder.
   */
  readonly record = Effect.fn("ForkVoiceNotes.record")(function* (
    this: ForkVoiceNotes,
    agentId: string,
    args: unknown,
  ) {
    if (!this.enabled(agentId))
      return yield* failed(
        "Voice notes are off for you: the user turned them off with /voicenotes off. Answer in text, and do not call send_voice_note again unless the user turns them on.",
      );
    const parsed = sendVoiceNoteToolSchema.safeParse(isDynamicRecord(args) ? args : {});
    if (!parsed.success) {
      const tooLong = parsed.error.issues.find((issue) => issue.code === "too_big");
      return yield* failed(
        tooLong
          ? `send_voice_note takes at most ${SPEECH_LIMITS.maximumTextLength} characters. Shorten the note and call it again.`
          : "send_voice_note needs text: the short note to speak, at most 1000 characters. Correct the arguments and retry.",
      );
    }
    const speech = this.#speech();
    if (!speech) return yield* failed("Voice notes are not available on this computer. Answer in text.");
    const encoder = findEncoder();
    if (!encoder)
      return yield* failed(
        "No MP3 encoder: install ffmpeg (brew install ffmpeg) to send voice notes. Answer in text and tell the user this in one line.",
      );
    const notReady = yield* speech.prepare();
    if (notReady !== null)
      return yield* failed(
        `The voice model is not ready: ${notReady} Answer in text and tell the user this in one line.`,
      );
    const audio = yield* speech
      .speak({ text: parsed.data.text, language: parsed.data.language ?? "en" })
      .pipe(Effect.mapError((error) => failed(`The voice could not read the note: ${error.message}`)));
    const folder = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(this.#scratchRoot, { recursive: true, mode: 0o700 });
        return mkdtemp(join(this.#scratchRoot, "note-"));
      },
      catch: (cause) => new VoiceNoteFailed({ cause }),
    });
    const path = join(folder, `voice-note-${timeStamp(new Date())}.mp3`);
    yield* encodeMp3(encoder, audio, path).pipe(
      Effect.tapError(() => this.discard(folder)),
      Effect.mapError((cause) => new VoiceNoteFailed({ cause })),
    );
    return { folder, path, seconds: audio.pcm.byteLength / 2 / audio.sampleRate };
  });

  /** Removes a scratch folder of `record`. A failure only leaves a small file in the shared root. */
  discard(folder: string): Effect.Effect<void> {
    return Effect.promise(() => rm(folder, { recursive: true, force: true }).catch(() => undefined));
  }
}

function readState(path: string): VoiceNoteState {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (isDynamicRecord(value) && Array.isArray(value.off))
      return { version: 1, off: value.off.filter((id): id is string => typeof id === "string") };
  } catch {
    // No file yet, or a damaged one: every agent may send voice notes.
  }
  return { version: 1, off: [] };
}

/** A Dock-started app has a short PATH, so Homebrew's folders are searched too. */
function findEncoder(): { name: (typeof ENCODERS)[number]; path: string } | null {
  const folders = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...ENCODER_FOLDERS];
  for (const name of ENCODERS)
    for (const folder of folders) {
      const path = join(folder, name);
      if (existsSync(path)) return { name, path };
    }
  return null;
}

function encoderArgs(name: (typeof ENCODERS)[number], sampleRate: number, output: string): string[] {
  return name === "ffmpeg"
    ? [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
      ].concat(["-codec:a", "libmp3lame", "-b:a", `${BITRATE_KBPS}k`, "-y", output])
    : ["--quiet", "-r", "-s", String(sampleRate / 1000), "--bitwidth", "16", "--signed", "--little-endian"].concat([
        "-m",
        "m",
        "-b",
        String(BITRATE_KBPS),
        "-",
        output,
      ]);
}

function encodeMp3(
  encoder: { name: (typeof ENCODERS)[number]; path: string },
  audio: SpeechAudio,
  output: string,
): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    const child = spawn(encoder.path, encoderArgs(encoder.name, audio.sampleRate, output), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errorText = `${errorText}${chunk.toString("utf8")}`.slice(-500);
    });
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("close", (code) =>
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(new Error(`${encoder.name} stopped with code ${code}: ${errorText.trim() || "no output"}`)),
      ),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength));
    return Effect.sync(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
  });
}

function timeStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
