/**
 * Fork (docs/fork/FEATURES.md, "Voice notes"): an agent answers with a short spoken message, like a
 * voice memo. `openbot.send_voice_note({ text, language? })` has Deepgram Aura-2 read the text in the
 * voice of Settings → Voice ▸ Voice notes, and the router attaches the MP3 to the agent's reply with
 * the `attach_files_to_response` gateway. Ported from OpenMausBot's `send_voice_note` (1000
 * characters, a switch per agent).
 *
 * Deepgram, not the local Supertonic model: Elias found the local voice too flat, and Aura-2 sends an
 * MP3 back, so nothing runs on this Mac (no model in memory, no encoder). The key is the Keychain item
 * `DEEPGRAM_API_KEY` (or the variable of the same name); only the note's text goes to Deepgram.
 */

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_VOICE_NOTE_VOICE,
  isVoiceNoteVoice,
  VOICE_NOTE_LANGUAGES,
  VOICE_NOTE_VOICES,
  type VoiceNoteSample,
  type VoiceNoteSettings,
  type VoiceNoteVoice,
  voiceNoteLanguage,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Schema } from "effect";
import { z } from "zod";

export const SEND_VOICE_NOTE_TOOL = "send_voice_note";
const FILE = "fork-voice-notes.json";
/** Where a note is written before the gateway copies it into the attachment store. Inside the shared root. */
const SCRATCH_FOLDER = ".voice-notes";
const MAXIMUM_TEXT_LENGTH = 1_000;
const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
const DEEPGRAM_TIMEOUT_MS = 30_000;
const KEYCHAIN_SERVICE = "DEEPGRAM_API_KEY";

export const sendVoiceNoteToolSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(MAXIMUM_TEXT_LENGTH)
    .describe("The words to speak, as you would say them: plain sentences, no Markdown, links, code or emoji."),
  language: z
    .enum(VOICE_NOTE_LANGUAGES)
    .optional()
    .describe("The language of the text, when it is not the language of the user's voice (ISO 639-1)."),
});

/** A voice note that could not be made. The message tells the agent what to do. */
export class VoiceNoteFailed extends Schema.TaggedError<VoiceNoteFailed>()("VoiceNoteFailed", {
  cause: Schema.Defect(),
}) {}

const failed = (message: string) => new VoiceNoteFailed({ cause: new Error(message) });

interface VoiceNoteState {
  version: 1;
  /** Agents whose voice notes are off. Every other agent may send them. */
  off: string[];
  voice: VoiceNoteVoice;
}

export class ForkVoiceNotes {
  readonly #path: string;
  readonly #scratchRoot: string;
  #state: VoiceNoteState;

  constructor(options: { databasePath: string; sharedRoot: string }) {
    this.#path = join(dirname(options.databasePath), FILE);
    this.#scratchRoot = join(options.sharedRoot, SCRATCH_FOLDER);
    this.#state = readState(this.#path);
  }

  enabled(agentId: string): boolean {
    return !this.#state.off.includes(agentId);
  }

  setEnabled(agentId: string, on: boolean): void {
    const off = this.#state.off.filter((id) => id !== agentId);
    this.#save({ ...this.#state, off: on ? off : [...off, agentId] });
  }

  voice(): VoiceNoteVoice {
    return this.#state.voice;
  }

  /** For Settings: the voice, and whether the Deepgram key is there. */
  readonly settings = Effect.fn("ForkVoiceNotes.settings")(function* (this: ForkVoiceNotes) {
    const key = yield* readDeepgramKey();
    return { voice: this.#state.voice, keyFound: key !== null } satisfies VoiceNoteSettings;
  });

  readonly setVoice = Effect.fn("ForkVoiceNotes.setVoice")(function* (this: ForkVoiceNotes, voice: VoiceNoteVoice) {
    this.#save({ ...this.#state, voice });
    return yield* this.settings();
  });

  /** A sample sentence in a voice, for the Listen button of Settings. */
  readonly preview = Effect.fn("ForkVoiceNotes.preview")(function* (
    this: ForkVoiceNotes,
    voice: VoiceNoteVoice,
    text: string,
  ) {
    const mp3 = yield* speak(voice, text);
    return { mp3 } satisfies VoiceNoteSample;
  });

  /**
   * Speaks the text and writes the MP3 in a new scratch folder. The caller attaches the file, then
   * calls `discard` with the returned folder.
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
          ? `send_voice_note takes at most ${MAXIMUM_TEXT_LENGTH} characters. Shorten the note and call it again.`
          : "send_voice_note needs text: the short note to speak, at most 1000 characters. Correct the arguments and retry.",
      );
    }
    const voice = voiceFor(this.#state.voice, parsed.data.language);
    const mp3 = yield* speak(voice, parsed.data.text);
    return yield* Effect.tryPromise({
      try: async () => {
        await mkdir(this.#scratchRoot, { recursive: true, mode: 0o700 });
        const folder = await mkdtemp(join(this.#scratchRoot, "note-"));
        const path = join(folder, `voice-note-${timeStamp(new Date())}.mp3`);
        await writeFile(path, mp3, { mode: 0o600 });
        return { folder, path, voice };
      },
      catch: (cause) => new VoiceNoteFailed({ cause }),
    });
  });

  /** Removes a scratch folder of `record`. A failure only leaves a small file in the shared root. */
  discard(folder: string): Effect.Effect<void> {
    return Effect.promise(() => rm(folder, { recursive: true, force: true }).catch(() => undefined));
  }

  #save(state: VoiceNoteState): void {
    this.#state = state;
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}

function readState(path: string): VoiceNoteState {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (isDynamicRecord(value) && Array.isArray(value.off))
      return {
        version: 1,
        off: value.off.filter((id): id is string => typeof id === "string"),
        voice: isVoiceNoteVoice(value.voice) ? value.voice : DEFAULT_VOICE_NOTE_VOICE,
      };
  } catch {
    // No file yet, or a damaged one: every agent may send voice notes, in the default voice.
  }
  return { version: 1, off: [], voice: DEFAULT_VOICE_NOTE_VOICE };
}

/**
 * The chosen voice, or for a text in another language a voice of that language: of the same gender
 * when there is one.
 */
function voiceFor(chosen: VoiceNoteVoice, language: string | undefined): VoiceNoteVoice {
  if (!language || voiceNoteLanguage(chosen) === language) return chosen;
  const gender = VOICE_NOTE_VOICES.find((voice) => voice.id === chosen)?.gender;
  const inLanguage = VOICE_NOTE_VOICES.filter((voice) => voiceNoteLanguage(voice.id) === language);
  return (inLanguage.find((voice) => voice.gender === gender) ?? inLanguage[0])?.id ?? chosen;
}

/** The key from the Keychain, else from the environment; null when neither has it. Never logged. */
function readDeepgramKey(): Effect.Effect<string | null> {
  return Effect.promise(
    () =>
      new Promise<string | null>((resolve) => {
        execFile(
          "/usr/bin/security",
          ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
          { timeout: 5_000 },
          (error, stdout) => {
            const key = error ? "" : stdout.trim();
            resolve(key || process.env.DEEPGRAM_API_KEY?.trim() || null);
          },
        );
      }),
  );
}

function speak(voice: VoiceNoteVoice, text: string): Effect.Effect<Uint8Array, VoiceNoteFailed> {
  return Effect.gen(function* () {
    const key = yield* readDeepgramKey();
    if (!key)
      return yield* failed(
        "No Deepgram key: save it in the Keychain as DEEPGRAM_API_KEY. Answer in text and tell the user this in one line.",
      );
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${DEEPGRAM_SPEAK_URL}?model=${encodeURIComponent(voice)}&encoding=mp3`, {
          method: "POST",
          headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS)]),
        }),
      catch: () => failed("Deepgram did not answer. Answer in text and tell the user this in one line."),
    });
    if (!response.ok) {
      const detail = yield* Effect.promise(() => response.text().catch(() => ""));
      return yield* failed(deepgramFailure(response.status, detail));
    }
    const bytes = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: () => failed("Deepgram stopped sending the audio. Try once more, then answer in text."),
    });
    if (bytes.byteLength === 0) return yield* failed("Deepgram sent no audio. Answer in text.");
    return new Uint8Array(bytes);
  });
}

function deepgramFailure(status: number, detail: string): string {
  if (status === 401 || status === 403)
    return "Deepgram refused the key in the Keychain (DEEPGRAM_API_KEY). Answer in text and tell the user this in one line.";
  if (status === 402) return "The Deepgram credit ran out. Answer in text and tell the user this in one line.";
  if (status === 429) return "Deepgram is busy (too many requests). Wait a few seconds and try once more.";
  return `Deepgram answered ${status}: ${detail.replace(/\s+/gu, " ").slice(0, 200)}`;
}

function timeStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
