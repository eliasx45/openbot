/**
 * Fork (docs/fork/FEATURES.md, "Review cards"). The pause notes of an `ask_ui` form: the user paused
 * the clip of a field and wrote a note at the frame on screen. The agent gets each note with that
 * frame as a PNG, so it sees what the user saw.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUiFormClipNote, type UiBlockSpec, uiFormClipNotesKey } from "@openbot/contracts/ui-blocks";
import { Effect } from "effect";

export interface CardNote {
  field: string;
  /** Seconds in the file. */
  time: number;
  text: string;
  file: string;
  /** A PNG of the frame at `time`, when ffmpeg could make it. */
  frame?: string;
}

/** The notes in the answers to a form's fallback questions. */
export function cardNotes(spec: UiBlockSpec, answers: Readonly<Record<string, readonly string[]>>): CardNote[] {
  if (spec.type !== "form") return [];
  return spec.fields.flatMap((field) => {
    if (!field.clip) return [];
    const file = field.clip.path;
    return (answers[uiFormClipNotesKey(field.id)] ?? []).flatMap((value) => {
      const note = readUiFormClipNote(value);
      return note ? [{ field: field.id, time: note.time, text: note.text, file }] : [];
    });
  });
}

// The app's PATH may not hold Homebrew.
const FFMPEG_PATHS = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"];

function extractFrame(file: string, time: number, out: string, index = 0): Promise<boolean> {
  const ffmpeg = FFMPEG_PATHS[index];
  if (!ffmpeg) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      ffmpeg,
      ["-v", "error", "-y", "-ss", time.toFixed(3), "-i", file, "-frames:v", "1", out],
      { timeout: 20_000 },
      (error) => {
        if (!error) resolve(true);
        else if (error.code === "ENOENT") resolve(extractFrame(file, time, out, index + 1));
        else resolve(false);
      },
    );
  });
}

/** Adds `frame` to each note whose frame ffmpeg could write. A note without one keeps its time and words. */
export function withNoteFrames(blockId: string, notes: CardNote[]): Effect.Effect<CardNote[]> {
  if (notes.length === 0) return Effect.succeed(notes);
  return Effect.promise(async () => {
    const folder = join(tmpdir(), "openbot-card-notes", blockId.replace(/[^A-Za-z0-9_-]/gu, "_"));
    await mkdir(folder, { recursive: true }).catch(() => undefined);
    return Promise.all(
      notes.map(async (note, index) => {
        const frame = join(folder, `${index + 1}-${note.field}-${note.time.toFixed(2)}s.png`);
        return (await extractFrame(note.file, note.time, frame)) ? { ...note, frame } : note;
      }),
    );
  });
}
