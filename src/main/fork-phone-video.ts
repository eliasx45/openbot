/**
 * Fork (docs/fork/FEATURES.md #70, "Videos play on the phone"): the mobile app shows a video only up to
 * `MOBILE_ATTACHMENT_BYTES` (10 MB); a larger one is a "too large for mobile" card (team-client
 * `file-upload.ts`, mobile `chat-attachment.tsx` `playable`). Bots attach edit renders of 10-80 MB.
 *
 * The host makes a phone copy of such a video (480p H.264 Main + AAC, MP4 with faststart, a bitrate
 * that keeps it under 9 MB) and the team API gives remote clients the copy in place of the original:
 * the conversation routes swap the attachment summary, and `/v1/attachments/<copy id>` serves the copy.
 * The desktop app reads the original, which is unchanged. A video the phone can already play (H.264 or
 * HEVC 8-bit in MP4/MOV, at most 10 MB) is left as it is; so is one ffmpeg cannot read.
 *
 * Copies live in `<userData>/fork-phone-video/<original id>/`, with `index.json`. Nothing of the
 * upstream mobile app changes: it sees a smaller, playable attachment.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

/** team-client `MOBILE_ATTACHMENT_BYTES` (`file-upload.ts`), which the package does not export alone; a test keeps them equal. */
export const MOBILE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** The id prefix of a phone copy. The rest is the original's id. */
export const PHONE_COPY_PREFIX = "fork-phone-";
/** The copy's whole size stays under this, with room below the phone's 10 MB limit. */
const COPY_BUDGET_BYTES = 9 * 1024 * 1024;
const MAX_VIDEO_KBPS = 1400;
const MIN_VIDEO_KBPS = 150;
const AUDIO_KBPS = 96;
const CONCURRENCY = 2;
/** A route waits at most this long for copies before it answers with what is ready. */
export const PHONE_COPY_WAIT_MS = 20_000;
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"];
const FFPROBE = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"];
/** Codecs the iOS and Android players read in an MP4/MOV, in 8-bit 4:2:0. */
const PHONE_CODECS = new Set(["h264", "hevc"]);

type Entry =
  | { state: "ready"; copyId: string; name: string; size: number; path: string }
  | { state: "skip"; reason: string; at?: number };

export interface PhoneVideoSource {
  path: string;
  mimeType: string;
  name: string;
}

export interface ForkPhoneVideoOptions {
  root: string;
  /** The original's file, or null when the host has none for this id. */
  resolve(attachmentId: string): Promise<PhoneVideoSource | null>;
  warn?(message: string, detail: { attachmentId: string; error: string }): void;
  /** Tests: the encoder and prober. */
  run?(command: "ffmpeg" | "ffprobe", args: string[]): Promise<{ code: number; stdout: string }>;
}

export class ForkPhoneVideo {
  readonly #root: string;
  readonly #options: ForkPhoneVideoOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #jobs = new Map<string, Promise<void>>();
  readonly #queue: (() => void)[] = [];
  #running = 0;

  constructor(options: ForkPhoneVideoOptions) {
    this.#root = options.root;
    this.#options = options;
    try {
      const saved = JSON.parse(readFileSync(join(this.#root, "index.json"), "utf8"));
      if (isDynamicRecord(saved) && isDynamicRecord(saved.entries))
        for (const [id, entry] of Object.entries(saved.entries)) {
          if (!isDynamicRecord(entry)) continue;
          if (
            entry.state === "ready" &&
            typeof entry.copyId === "string" &&
            typeof entry.name === "string" &&
            typeof entry.size === "number" &&
            typeof entry.path === "string" &&
            existsSync(entry.path)
          )
            this.#entries.set(id, {
              state: "ready",
              copyId: entry.copyId,
              name: entry.name,
              size: entry.size,
              path: entry.path,
            });
          else if (entry.state === "skip" && typeof entry.reason === "string")
            this.#entries.set(id, {
              state: "skip",
              reason: entry.reason,
              ...(typeof entry.at === "number" ? { at: entry.at } : {}),
            });
        }
    } catch {}
  }

  /** Whether a remote client could need a copy of this attachment. Only probing decides a small one. */
  static candidate(attachment: AttachmentSummary): boolean {
    return attachment.mimeType.startsWith("video/") && !attachment.id.startsWith(PHONE_COPY_PREFIX);
  }

  /** Makes the copies these messages need, waiting at most `waitMs`. Never fails. */
  async prepare(messages: readonly { attachments?: AttachmentSummary[] | undefined }[], waitMs = PHONE_COPY_WAIT_MS) {
    const jobs: Promise<void>[] = [];
    for (const message of messages)
      for (const attachment of message.attachments ?? [])
        if (ForkPhoneVideo.candidate(attachment) && !this.#entries.has(attachment.id)) jobs.push(this.#job(attachment));
    if (jobs.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(jobs),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The phone copy in place of the original, when one is ready. */
  swap(attachment: AttachmentSummary): AttachmentSummary {
    const entry = this.#entries.get(attachment.id);
    if (entry?.state !== "ready") return attachment;
    return {
      id: entry.copyId,
      name: entry.name,
      size: entry.size,
      kind: "file",
      mimeType: "video/mp4",
      previewKind: "none",
      previewUrl: null,
    };
  }

  /** A message with its videos swapped; the same object when nothing changed. */
  swapMessage<M extends { attachments?: AttachmentSummary[] | undefined }>(message: M): M {
    if (!message.attachments?.some((attachment) => this.#entries.get(attachment.id)?.state === "ready")) return message;
    return { ...message, attachments: message.attachments.map((attachment) => this.swap(attachment)) };
  }

  /** The file of a phone copy id, for `/v1/attachments/<id>`. */
  resolveCopy(id: string): PhoneVideoSource | null {
    if (!id.startsWith(PHONE_COPY_PREFIX)) return null;
    const entry = this.#entries.get(id.slice(PHONE_COPY_PREFIX.length));
    if (entry?.state !== "ready" || !existsSync(entry.path)) return null;
    return { path: entry.path, mimeType: "video/mp4", name: entry.name };
  }

  #job(attachment: AttachmentSummary): Promise<void> {
    const running = this.#jobs.get(attachment.id);
    if (running) return running;
    const job = this.#slot(() => this.#make(attachment))
      .catch((error: unknown) => {
        this.#options.warn?.("A phone copy of a video failed.", { attachmentId: attachment.id, error: String(error) });
        // `at` lets the health check (openbot-phone-video) see recent failures.
        this.#entries.set(attachment.id, { state: "skip", reason: "failed", at: Date.now() });
      })
      .finally(() => {
        this.#jobs.delete(attachment.id);
        this.#save();
      });
    this.#jobs.set(attachment.id, job);
    return job;
  }

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= CONCURRENCY) await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#running += 1;
    try {
      return await work();
    } finally {
      this.#running -= 1;
      this.#queue.shift()?.();
    }
  }

  async #make(attachment: AttachmentSummary): Promise<void> {
    const source = await this.#options.resolve(attachment.id);
    if (!source || !existsSync(source.path)) {
      this.#entries.set(attachment.id, { state: "skip", reason: "no file" });
      return;
    }
    const size = statSync(source.path).size;
    const probe = await this.#probe(source.path);
    if (!probe) {
      this.#entries.set(attachment.id, { state: "skip", reason: "unreadable" });
      return;
    }
    if (size <= MOBILE_ATTACHMENT_BYTES && phonePlayable(source.path, probe)) {
      this.#entries.set(attachment.id, { state: "skip", reason: "plays already" });
      return;
    }
    const videoKbps = phoneVideoKbps(probe.duration);
    if (videoKbps === null) {
      this.#entries.set(attachment.id, { state: "skip", reason: "too long for 10 MB" });
      return;
    }
    const folder = join(this.#root, safeSegment(attachment.id));
    mkdirSync(folder, { recursive: true });
    const name = phoneCopyName(source.name || basename(source.path));
    // The file keeps the copy's name: the attachment route names the download after the file.
    const path = join(folder, name.replace(/[/\\\p{Cc}]/gu, "_"));
    const temporary = join(folder, "copy.partial.mp4");
    const result = await this.#run("ffmpeg", phoneEncodeArgs(source.path, temporary, videoKbps, probe.hasAudio));
    if (result.code !== 0 || !existsSync(temporary)) {
      rmSync(temporary, { force: true });
      throw new Error(`ffmpeg exited ${result.code}`);
    }
    const copySize = statSync(temporary).size;
    if (copySize > MOBILE_ATTACHMENT_BYTES) {
      rmSync(temporary, { force: true });
      this.#entries.set(attachment.id, { state: "skip", reason: "copy over 10 MB" });
      return;
    }
    renameSync(temporary, path);
    this.#entries.set(attachment.id, {
      state: "ready",
      copyId: `${PHONE_COPY_PREFIX}${attachment.id}`,
      name,
      size: copySize,
      path,
    });
  }

  async #probe(path: string): Promise<VideoProbe | null> {
    const result = await this.#run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,pix_fmt",
      "-of",
      "json",
      path,
    ]);
    if (result.code !== 0) return null;
    return parseProbe(result.stdout);
  }

  #run(command: "ffmpeg" | "ffprobe", args: string[]) {
    return this.#options.run
      ? this.#options.run(command, args)
      : runTool(command === "ffmpeg" ? FFMPEG : FFPROBE, args);
  }

  #save(): void {
    try {
      mkdirSync(this.#root, { recursive: true });
      const file = join(this.#root, "index.json");
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, entries: Object.fromEntries(this.#entries) }));
      renameSync(`${file}.tmp`, file);
    } catch {}
  }
}

export interface VideoProbe {
  duration: number;
  videoCodec: string | null;
  pixelFormat: string | null;
  hasAudio: boolean;
}

export function parseProbe(stdout: string): VideoProbe | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isDynamicRecord(value)) return null;
  const streams = Array.isArray(value.streams) ? value.streams.filter(isDynamicRecord) : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) return null;
  const duration = isDynamicRecord(value.format) ? Number(value.format.duration) : Number.NaN;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    videoCodec: typeof video.codec_name === "string" ? video.codec_name : null,
    pixelFormat: typeof video.pix_fmt === "string" ? video.pix_fmt : null,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

/** H.264 or HEVC, 8-bit 4:2:0, in an MP4 or MOV: what the iOS and Android players read. */
export function phonePlayable(path: string, probe: VideoProbe): boolean {
  const extension = extname(path).toLowerCase();
  return (
    [".mp4", ".m4v", ".mov"].includes(extension) &&
    probe.videoCodec !== null &&
    PHONE_CODECS.has(probe.videoCodec) &&
    (probe.pixelFormat === "yuv420p" || probe.pixelFormat === "yuvj420p")
  );
}

/** The video bitrate that keeps the whole copy under the budget, or null when even the floor does not. */
export function phoneVideoKbps(durationSeconds: number): number | null {
  if (durationSeconds <= 0) return MAX_VIDEO_KBPS;
  const total = (COPY_BUDGET_BYTES * 8) / durationSeconds / 1000;
  const video = Math.floor(Math.min(MAX_VIDEO_KBPS, total - AUDIO_KBPS));
  return video >= MIN_VIDEO_KBPS ? video : null;
}

export function phoneEncodeArgs(input: string, output: string, videoKbps: number, hasAudio: boolean): string[] {
  return [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0"] : []),
    // The short side becomes 480 (never larger than the source), the long side even; at most 30 fps.
    "-vf",
    "scale='if(gt(iw,ih),-2,min(480,iw))':'if(gt(iw,ih),min(480,ih),-2)',fps=fps='min(source_fps,30)',format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "main",
    "-b:v",
    `${videoKbps}k`,
    "-maxrate",
    `${Math.floor(videoKbps * 1.5)}k`,
    "-bufsize",
    `${videoKbps * 2}k`,
    ...(hasAudio ? ["-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ac", "2"] : []),
    // No timecode or data track from an editor's export.
    "-dn",
    "-write_tmcd",
    "0",
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

export function phoneCopyName(name: string): string {
  const extension = extname(name);
  return `${(extension ? name.slice(0, -extension.length) : name).slice(0, 180)} · phone.mp4`;
}

function safeSegment(id: string): string {
  return id.replace(/[^\w.-]/gu, "_").replace(/^\.+/u, "_");
}

function runTool(candidates: string[], args: string[], index = 0): Promise<{ code: number; stdout: string }> {
  const command = candidates[index];
  if (!command) return Promise.resolve({ code: -1, stdout: "" });
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(runTool(candidates, args, index + 1)));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/** The running instance, set by the main process at start. */
export const forkPhoneVideo: { current: ForkPhoneVideo | null } = { current: null };

/** Fork: prepares and swaps the phone copies of a page of messages, for the team API routes. */
export async function phoneVideoMessages<M extends { attachments?: AttachmentSummary[] | undefined }>(
  messages: readonly M[],
): Promise<M[]> {
  const phone = forkPhoneVideo.current;
  if (!phone) return [...messages];
  await phone.prepare(messages);
  return messages.map((message) => phone.swapMessage(message));
}

/** Fork: the same for a conversation page, whose quoted messages can hold videos too. */
export async function phoneVideoPage<
  M extends { attachments?: AttachmentSummary[] | undefined },
  P extends { messages: M[]; references: Record<string, M> },
>(page: P): Promise<P> {
  const phone = forkPhoneVideo.current;
  if (!phone) return page;
  await phone.prepare([...page.messages, ...Object.values(page.references)]);
  return {
    ...page,
    messages: page.messages.map((message) => phone.swapMessage(message)),
    references: Object.fromEntries(
      Object.entries(page.references).map(([id, message]) => [id, phone.swapMessage(message)]),
    ),
  };
}
