// Fork (docs/fork/FEATURES.md, "Voice notes"): makes voice notes through `ForkVoiceNotes`, the
// service behind `openbot.send_voice_note` and the Voice notes row of Settings, with the real
// Deepgram Aura-2 API and the Keychain key `DEEPGRAM_API_KEY` (a few cents of the user's credit).
//
// Cases: an English note in the chosen voice becomes an MP3 (ffprobe reads its length); a French
// note switches to a French voice of the same gender; a Settings sample comes back as MP3; the voice
// survives a new instance; a note over 1000 characters, an empty one and a note while
// `/voicenotes off` are refused with a message the agent can act on, and the switch is per agent;
// the scratch folder is gone after `discard`.
//
// Writes the MP3 files and `report.json` to `.openbot-build/voice-note-e2e/`.

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit } from "effect";
import { ForkVoiceNotes } from "../src/backend/fork-voice-notes";

const OUTPUT = resolve(".openbot-build/voice-note-e2e");
const AGENT = "agent-voice-note-e2e";

const logger = createOpenBotLogger("voice-note-e2e");

interface NoteCase {
  file: string;
  voice: string;
  bytes: number;
  seconds: number;
  ms: number;
}

interface Cases {
  notes: Record<string, NoteCase>;
  sampleBytes: number;
  refusals: Record<"tooLong" | "empty" | "off", string>;
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
  const options = { databasePath: join(root, "openbot.db"), sharedRoot: join(root, "Shared") };
  const cases: Cases = { notes: {}, sampleBytes: 0, refusals: { tooLong: "", empty: "", off: "" } };
  try {
    const notes = new ForkVoiceNotes(options);
    const settings = await Effect.runPromise(notes.settings());
    check(settings.keyFound, "No Deepgram key in the Keychain (DEEPGRAM_API_KEY).");
    check(settings.voice === "aura-2-orion-en", `The default voice is ${settings.voice}.`);
    await Effect.runPromise(notes.setVoice("aura-2-apollo-en"));
    check(new ForkVoiceNotes(options).voice() === "aura-2-apollo-en", "The voice did not survive a new instance.");

    const runs = [
      { name: "en", args: { text: "Quick update: the intro is rendered and in Premiere." }, voice: "aura-2-apollo-en" },
      {
        name: "fr",
        args: { text: "Petit point rapide : l'intro est prête.", language: "fr" },
        voice: "aura-2-hector-fr",
      },
    ];
    for (const run of runs) {
      const startedAt = Date.now();
      const made = await Effect.runPromise(notes.record(AGENT, run.args));
      const ms = Date.now() - startedAt;
      check(made.voice === run.voice, `${run.name}: voice ${made.voice}, expected ${run.voice}.`);
      const bytes = (await stat(made.path)).size;
      const seconds = mp3Seconds(made.path);
      check(made.path.endsWith(".mp3") && bytes > 4_000 && seconds > 1, `${run.name}: not a usable MP3.`);
      const kept = join(OUTPUT, `${run.name}.mp3`);
      await copyFile(made.path, kept);
      await Effect.runPromise(notes.discard(made.folder));
      const gone = await stat(made.folder).then(
        () => false,
        () => true,
      );
      check(gone, `${run.name}: the scratch folder is still there.`);
      cases.notes[run.name] = { file: kept, voice: made.voice, bytes, seconds, ms };
    }

    const sample = await Effect.runPromise(notes.preview("aura-2-orion-en", "Hello. This is a sample."));
    check(sample.mp3.byteLength > 2_000, "The Settings sample is empty.");
    cases.sampleBytes = sample.mp3.byteLength;

    cases.refusals.tooLong = await refusal(notes, { text: "a".repeat(1001) });
    cases.refusals.empty = await refusal(notes, { text: "   " });
    notes.setEnabled(AGENT, false);
    cases.refusals.off = await refusal(notes, { text: "Hello." });
    check(!new ForkVoiceNotes(options).enabled(AGENT), "/voicenotes off did not survive a new instance.");
    check(new ForkVoiceNotes(options).enabled("another-agent"), "/voicenotes off changed another agent.");
    notes.setEnabled(AGENT, true);
    check(new ForkVoiceNotes(options).enabled(AGENT), "/voicenotes on did not survive a new instance.");
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
    await rm(root, { recursive: true, force: true });
  }
}

await main();
