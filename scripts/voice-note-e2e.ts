// Fork (docs/fork/FEATURES.md, "Voice notes"): makes voice notes with the real speech service,
// sherpa-onnx addon, Supertonic 3 model and Homebrew encoder, through `ForkVoiceNotes`, the service
// behind `openbot.send_voice_note`. The model downloads to the directory the dev app uses.
//
// Cases: an English and a French note become MP3 files whose length (ffprobe) matches the speech; a
// note over 1000 characters and an empty one are refused with a message the agent can act on;
// `/voicenotes off` refuses, survives a new instance (the file beside the database) and `on` allows
// again; the scratch folder is gone after `discard`.
//
// Writes the MP3 files and `report.json` to `.openbot-build/voice-note-e2e/`.
// Run `bun run voice:prepare-runtime` first. macOS only: it starts the Electron binary of the package.

import { execFileSync, fork } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SpeechLanguage } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit } from "effect";
import { ForkVoiceNotes } from "../src/backend/fork-voice-notes";
import { SpeechPreferenceStore } from "../src/main/speech-preference-store";
import { SUPERTONIC_MODEL_DIRECTORY } from "../src/main/voice-model-service";
import type { VoiceSpeechHostProcess, VoiceSpeechResponse } from "../src/main/voice-speech-protocol";
import { VoiceSpeechService } from "../src/main/voice-speech-service";

const RESOURCES_ROOT = resolve(".openbot-build/voice");
const OUTPUT = resolve(".openbot-build/voice-note-e2e");
const HOST = resolve("src/main/voice-speech-host.ts");
const ELECTRON = resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const AGENT = "agent-voice-note-e2e";

const logger = createOpenBotLogger("voice-note-e2e");

interface NoteCase {
  file: string;
  bytes: number;
  mp3Seconds: number;
  speechSeconds: number;
  ms: number;
}

interface Cases {
  notes: Record<string, NoteCase>;
  refusals: Record<"tooLong" | "empty" | "off", string>;
  onAgainSeconds: number;
}

const NOTES: readonly { name: string; language?: SpeechLanguage; text: string }[] = [
  { name: "en", text: "Quick update: the intro is rendered and in Premiere. Two cards still need your eye." },
  { name: "fr", language: "fr", text: "Petit point rapide : l'intro est prête, il reste deux cartes à vérifier." },
];

function spawnHost(): VoiceSpeechHostProcess {
  const child = fork(HOST, [], {
    execPath: ELECTRON,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    serialization: "json",
    stdio: "inherit",
  });
  return {
    send: (request) => child.send(request),
    onResponse: (listener) => {
      child.on("message", (message: unknown) => listener(responseFromJson(message)));
    },
    onExit: (listener) => {
      child.once("exit", () => listener());
    },
    kill: () => {
      child.kill();
    },
  };
}

function responseFromJson(message: unknown): VoiceSpeechResponse {
  if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "number")
    throw new Error("The host sent a message with no id.");
  if ("error" in message) {
    const error = message.error;
    if (error === "runtime-unavailable" || error === "model-load-failed" || error === "inference-failed")
      return { id: message.id, error };
    throw new Error("The host sent an unknown error.");
  }
  if (!("pcm" in message) || typeof message.pcm !== "object" || message.pcm === null)
    throw new Error("The host sent no audio.");
  if (!("sampleRate" in message) || typeof message.sampleRate !== "number")
    throw new Error("The host sent no sample rate.");
  const bytes = Object.values(message.pcm);
  if (!bytes.every((byte) => typeof byte === "number")) throw new Error("The host sent audio that is not bytes.");
  return { id: message.id, pcm: Uint8Array.from(bytes), sampleRate: message.sampleRate };
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** The refusal text of a `record` that must fail. */
async function refusal(notes: ForkVoiceNotes, args: unknown): Promise<string> {
  const exit = await Effect.runPromiseExit(notes.record(AGENT, args));
  check(Exit.isFailure(exit), "A note that must be refused was made.");
  return Exit.isFailure(exit) ? String(exit.cause).slice(0, 400) : "";
}

function mp3Seconds(path: string): number {
  const output = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(output.toString().trim());
}

async function main(): Promise<void> {
  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(OUTPUT, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "openbot-voice-note-e2e-"));
  const databasePath = join(root, "openbot.db");
  const sharedRoot = join(root, "Shared");
  const preferences = new SpeechPreferenceStore(join(root, "speech-preference.json"));
  const speech = new VoiceSpeechService({
    resourcesRoot: RESOURCES_ROOT,
    modelDirectory: join(RESOURCES_ROOT, SUPERTONIC_MODEL_DIRECTORY),
    preferences,
    spawnHost,
  });
  const port = {
    prepare: () =>
      speech.downloadModel().pipe(
        Effect.map((status) => (status.phase === "ready" ? null : (status.message ?? status.phase))),
        Effect.catch((error) => Effect.succeed(String(error.cause))),
      ),
    speak: (input: { text: string; language: SpeechLanguage }) =>
      speech.speak(input).pipe(Effect.mapError((error) => new Error(String(error.cause)))),
  };
  const make = () => new ForkVoiceNotes({ databasePath, sharedRoot, speech: () => port });
  const cases: Cases = { notes: {}, refusals: { tooLong: "", empty: "", off: "" }, onAgainSeconds: 0 };
  try {
    const notes = make();
    for (const note of NOTES) {
      const startedAt = Date.now();
      const made = await Effect.runPromise(notes.record(AGENT, { text: note.text, language: note.language }));
      const ms = Date.now() - startedAt;
      const size = (await stat(made.path)).size;
      const seconds = mp3Seconds(made.path);
      check(basename(made.path).endsWith(".mp3"), `${note.name}: not an MP3 name.`);
      check(size > 4_000, `${note.name}: the MP3 is too small (${size} bytes).`);
      check(Math.abs(seconds - made.seconds) < 0.5, `${note.name}: MP3 ${seconds}s, speech ${made.seconds}s.`);
      const kept = join(OUTPUT, `${note.name}.mp3`);
      await copyFile(made.path, kept);
      await Effect.runPromise(notes.discard(made.folder));
      const gone = await stat(made.folder).then(
        () => false,
        () => true,
      );
      check(gone, `${note.name}: the scratch folder is still there.`);
      cases.notes[note.name] = { file: kept, bytes: size, mp3Seconds: seconds, speechSeconds: made.seconds, ms };
    }
    cases.refusals.tooLong = await refusal(notes, { text: "a".repeat(1001) });
    cases.refusals.empty = await refusal(notes, { text: "   " });
    notes.setEnabled(AGENT, false);
    cases.refusals.off = await refusal(notes, { text: "Hello." });
    check(!make().enabled(AGENT), "/voicenotes off did not survive a new instance.");
    check(make().enabled("another-agent"), "/voicenotes off changed another agent.");
    notes.setEnabled(AGENT, true);
    check(make().enabled(AGENT), "/voicenotes on did not survive a new instance.");
    const again = await Effect.runPromise(notes.record(AGENT, { text: "Back on." }));
    await Effect.runPromise(notes.discard(again.folder));
    cases.onAgainSeconds = again.seconds;
    for (const [key, text] of Object.entries(cases.refusals))
      check(
        text.includes("send_voice_note") || text.includes("/voicenotes"),
        `The ${key} refusal says nothing the agent can act on.`,
      );
    const report = { ok: true, at: new Date().toISOString(), cases };
    await writeFile(join(OUTPUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    logger.info(`Report: ${join(OUTPUT, "report.json")}`);
  } catch (error) {
    await writeFile(
      join(OUTPUT, "report.json"),
      `${JSON.stringify({ ok: false, error: String(error), cases }, null, 2)}\n`,
    );
    throw error;
  } finally {
    await Effect.runPromise(speech.shutdown());
    await rm(root, { recursive: true, force: true });
  }
}

await main();
