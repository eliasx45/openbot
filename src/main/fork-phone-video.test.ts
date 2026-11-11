// @vitest-environment node
// Fork (docs/fork/FEATURES.md #70, "Videos play on the phone"): real ffmpeg on generated clips. A 1080p
// H.264 clip over 10 MB and a small VP9 WebM get a 480p H.264 phone copy under 10 MB; a small H.264 MP4
// stays as it is; a page swaps its videos (quoted ones too) and the copy id resolves to the copy's file.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_ATTACHMENT_BYTES as TEAM_CLIENT_LIMIT } from "../../packages/team-client/src/file-upload";
import {
  ForkPhoneVideo,
  forkPhoneVideo,
  MOBILE_ATTACHMENT_BYTES,
  PHONE_COPY_PREFIX,
  parseProbe,
  phoneVideoKbps,
  phoneVideoPage,
} from "./fork-phone-video";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
let root = "";
const files: Record<string, string> = {};

function make(name: string, args: string[]) {
  const path = join(root, name);
  const result = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args, path]);
  if (result.status !== 0) throw new Error(String(result.stderr));
  files[name] = path;
}

function summary(id: string, name: string, mimeType: string): AttachmentSummary {
  return {
    id,
    name,
    size: statSync(files[name] ?? "").size,
    kind: "file",
    mimeType,
    previewKind: "none",
    previewUrl: "openbot-attachment://file/x",
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-phone-video-"));
  if (!hasFfmpeg) return;
  const source = [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=30:duration=8",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=8",
  ];
  // 8 s at 14 Mbit/s: about 14 MB, as a bot's edit render.
  make("render.mp4", [...source, "-c:v", "libx264", "-b:v", "14M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
  make("small.mp4", [...source, "-c:v", "libx264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
  make("spread.webm", [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:duration=4",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "500k",
  ]);
}, 120_000);

afterAll(async () => {
  forkPhoneVideo.current = null;
  await rm(root, { recursive: true, force: true });
});

function service() {
  const byId: Record<string, string> = { a: "render.mp4", b: "small.mp4", c: "spread.webm" };
  return new ForkPhoneVideo({
    root: join(root, "copies"),
    resolve: async (id) => {
      const name = byId[id];
      return name ? { path: files[name] ?? "", mimeType: "video/mp4", name } : null;
    },
  });
}

describe("phone copies of videos", () => {
  it("keeps the same limit as the mobile app", () => {
    expect(MOBILE_ATTACHMENT_BYTES).toBe(TEAM_CLIENT_LIMIT);
  });

  it("picks a bitrate that keeps the copy under 9 MB", () => {
    expect(phoneVideoKbps(10)).toBe(1400);
    expect(phoneVideoKbps(84)).toBe(802);
    expect(phoneVideoKbps(60 * 60)).toBeNull();
  });

  it("reads ffprobe's answer", () => {
    expect(
      parseProbe(
        JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "prores", pix_fmt: "yuv422p10le" }, { codec_type: "audio" }],
          format: { duration: "12.5" },
        }),
      ),
    ).toEqual({ duration: 12.5, videoCodec: "prores", pixelFormat: "yuv422p10le", hasAudio: true });
    expect(parseProbe("{}")).toBeNull();
  });

  it.skipIf(!hasFfmpeg)(
    "copies a large render and a WebM, leaves a small MP4, and swaps them in a page",
    async () => {
      const phone = service();
      forkPhoneVideo.current = phone;
      const render = summary("a", "render.mp4", "video/mp4");
      const small = summary("b", "small.mp4", "video/mp4");
      const webm = summary("c", "spread.webm", "video/webm");
      expect(render.size).toBeGreaterThan(MOBILE_ATTACHMENT_BYTES);
      const page = await phoneVideoPage({
        messages: [{ id: "m1", attachments: [render, small] }],
        references: { q: { id: "m0", attachments: [webm] } },
      });
      const [renderCopy, smallKept] = page.messages[0]?.attachments ?? [];
      const webmCopy = page.references.q?.attachments?.[0];
      expect(renderCopy?.id).toBe(`${PHONE_COPY_PREFIX}a`);
      expect(renderCopy?.name).toBe("render · phone.mp4");
      expect(renderCopy?.mimeType).toBe("video/mp4");
      expect(renderCopy?.size).toBeLessThan(MOBILE_ATTACHMENT_BYTES);
      expect(smallKept).toBe(small);
      expect(webmCopy?.id).toBe(`${PHONE_COPY_PREFIX}c`);
      const file = phone.resolveCopy(`${PHONE_COPY_PREFIX}a`);
      expect(file?.path.endsWith("render · phone.mp4")).toBe(true);
      const probe = spawnSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,profile,height,pix_fmt",
        "-of",
        "csv=p=0",
        file?.path ?? "",
      ]);
      expect(String(probe.stdout)).toContain("h264,Main,480,yuv420p");
      expect(String(probe.stdout)).toContain("aac");
      expect(statSync(file?.path ?? "").size).toBe(renderCopy?.size);
      // A restart reads the copies back.
      const again = service();
      expect(again.swap(render).id).toBe(`${PHONE_COPY_PREFIX}a`);
      expect(again.swap(small)).toBe(small);
      expect(again.resolveCopy("a")).toBeNull();
    },
    120_000,
  );
});
