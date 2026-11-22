// Fork (docs/fork/FEATURES.md, "Video speed"): − · 1× · + on a chat video sets its speed, keeps the
// click from the player, and shows once (in the title line) until full screen.
import { AttachmentCards } from "@openbot/ui/features/conversation/AttachmentCards";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { expect, it, vi } from "vitest";

/** A click, then the screen as Solid shows it after the click. */
function click(element: HTMLElement) {
  fireEvent.click(element);
  flush();
}

const clip = {
  id: "clip",
  name: "clip.mp4",
  size: 16.4 * 1024 * 1024,
  kind: "file",
  mimeType: "video/mp4",
  previewKind: "none",
  previewUrl: "openbot-attachment://file/clip",
} as const;

function show() {
  // The chat: a video that an agent attached to its reply.
  render(() => <AttachmentCards attachments={[clip]} onPreview={vi.fn()} onAction={vi.fn()} />);
  const video = document.querySelector("video");
  if (!video) throw new Error("no video");
  return video;
}

it("steps the speed with + and −, stops at the ends, and resets with the readout", () => {
  const video = show();
  const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
  const faster = screen.getByRole("button", { name: "Faster" });
  const slower = screen.getByRole("button", { name: "Slower" });
  const reset = screen.getByRole("button", { name: "Reset speed" });
  expect(reset.textContent).toBe("1×");
  expect(video.playbackRate).toBe(1);

  const fast: string[] = [];
  for (let step = 0; step < 7; step += 1) {
    click(faster);
    fast.push(`${video.playbackRate}|${reset.textContent}`);
  }
  expect(fast).toEqual(["1.25|1.25×", "1.5|1.5×", "1.75|1.75×", "2|2×", "2.5|2.5×", "3|3×", "3|3×"]);
  expect(faster.hasAttribute("disabled")).toBe(true);

  click(reset);
  expect(video.playbackRate).toBe(1);
  expect(reset.textContent).toBe("1×");

  click(slower);
  click(slower);
  click(slower);
  expect(video.playbackRate).toBe(0.5);
  expect(reset.textContent).toBe("0.5×");
  expect(slower.hasAttribute("disabled")).toBe(true);
  expect(faster.hasAttribute("disabled")).toBe(false);

  // No click played, paused or opened full screen.
  expect(play).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button", { name: "Play video", hidden: true }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("group", { name: "Playback speed" })).toHaveLength(1);
});

it("shows the speed set elsewhere, as in full screen", () => {
  const video = show();
  video.playbackRate = 2;
  fireEvent(video, new Event("ratechange"));
  flush();
  expect(screen.getByRole("button", { name: "Reset speed" }).textContent).toBe("2×");
});

it("shows one control until full screen", () => {
  show();
  // The title line has it; the bar at the bottom adds a copy only in full screen.
  expect(screen.getAllByRole("group", { name: "Playback speed" })).toHaveLength(1);
});
