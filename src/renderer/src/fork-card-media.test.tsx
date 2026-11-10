// Fork (docs/fork/FEATURES.md, "Card media"): the card draws its video and image under the title, keeps a
// video inside its range, names a file it cannot show, and keeps the media once it is answered.
import type { UiBlockSpec, UiBlockState } from "@openbot/contracts/ui-blocks";
import { UiBlockingBlock } from "@openbot/ui/features/conversation/ui-blocks/UiBlockingBlock";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

const spec: UiBlockSpec = {
  type: "confirm",
  title: "Healthier (6:41): make its heartbeat line one smooth draw too?",
  actions: [
    { id: "keep", label: "Keep" },
    { id: "smooth", label: "One smooth draw", style: "primary" },
  ],
  media: [
    { path: "/v/heartbeat.mp4", start: 2, end: 5, caption: "The gold line", src: "openbot-attachment://file/vid1" },
    { path: "/v/frame.png", src: "openbot-attachment://file/img1" },
    { path: "/v/gone.mp4" },
  ],
};

function show(state: UiBlockState = { status: "pending" }, onRespond = vi.fn()) {
  return render(() => <UiBlockingBlock spec={spec} state={state} onRespond={onRespond} />);
}

it("shows the video with controls and sound, the image, the caption and a missing file's name", () => {
  show();
  const video = document.querySelector<HTMLVideoElement>("video.ui-block-media-video");
  expect(video?.getAttribute("src")).toBe("openbot-attachment://file/vid1");
  expect(video?.controls).toBe(true);
  expect(video?.muted).toBe(false);
  expect(video?.getAttribute("preload")).toBe("metadata");
  expect(screen.getByText("The gold line")).toBeTruthy();
  expect(screen.getByRole("img", { name: "frame.png" }).getAttribute("src")).toBe("openbot-attachment://file/img1");
  expect(screen.getByText("gone.mp4 can't be shown here")).toBeTruthy();
  // Media comes before the body: under the title, above the fields and buttons.
  const card = document.querySelector(".ui-block-content");
  expect(card?.children[1]?.classList.contains("ui-block-media")).toBe(true);
});

it("starts the video at start and loops at end", () => {
  show();
  const video = document.querySelector<HTMLVideoElement>("video.ui-block-media-video");
  if (!video) throw new Error("no video");
  const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
  fireEvent(video, new Event("loadedmetadata"));
  expect(video.currentTime).toBe(2);
  Object.defineProperty(video, "paused", { configurable: true, value: false });
  video.currentTime = 5.2;
  fireEvent(video, new Event("timeupdate"));
  expect(video.currentTime).toBe(2);
  expect(play).toHaveBeenCalled();
  video.currentTime = 0.5;
  fireEvent(video, new Event("seeked"));
  expect(video.currentTime).toBe(2);
});

it("names a video that fails to load", async () => {
  show();
  const video = document.querySelector<HTMLVideoElement>("video.ui-block-media-video");
  if (!video) throw new Error("no video");
  fireEvent(video, new Event("error"));
  expect(await screen.findByText(/heartbeat\.mp4/u)).toBeTruthy();
  expect(document.querySelector("video")).toBeNull();
});

it("opens the image in the image viewer", async () => {
  if (!("animate" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => ({ finished: Promise.resolve(), cancel: vi.fn(), finish: vi.fn() }),
    });
  }
  show();
  const button = document.querySelector<HTMLButtonElement>(".ui-block-media-image");
  if (!button) throw new Error("no image button");
  fireEvent.click(button);
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

it("still answers, and an answered card keeps its media", () => {
  const onRespond = vi.fn();
  show({ status: "pending" }, onRespond);
  fireEvent.click(screen.getByRole("button", { name: "One smooth draw" }));
  expect(onRespond).toHaveBeenCalledWith({ actionId: "smooth" });
  document.body.innerHTML = "";
  show({ status: "answered", response: { actionId: "smooth" }, outcome: "One smooth draw" });
  expect(screen.getByLabelText("The gold line").tagName).toBe("VIDEO");
});
