// Fork (docs/fork/FEATURES.md #75): a card clip that loops with sound went on playing after Elias
// left its chat. A playing video now pauses once no part of it is on screen.
import { installHiddenVideoPause } from "@openbot/ui/hidden-video-pause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Callback = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
let observed: Set<Element>;
let notify: Callback;
let uninstall: () => void;

beforeEach(() => {
  observed = new Set();
  class FakeObserver {
    constructor(callback: Callback) {
      notify = callback;
    }
    observe(target: Element) {
      observed.add(target);
    }
    unobserve(target: Element) {
      observed.delete(target);
    }
    disconnect() {
      observed.clear();
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  uninstall = installHiddenVideoPause(document);
});

afterEach(() => {
  uninstall();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function playingVideo(): { video: HTMLVideoElement; pause: ReturnType<typeof vi.fn> } {
  const video = document.createElement("video");
  document.body.append(video);
  let paused = false;
  Object.defineProperty(video, "paused", { get: () => paused });
  const pause = vi.fn(() => {
    paused = true;
    video.dispatchEvent(new Event("pause"));
  });
  video.pause = pause;
  video.dispatchEvent(new Event("play"));
  return { video, pause };
}

describe("a playing video", () => {
  it("pauses when it leaves the screen, as when its chat is left", () => {
    const { video, pause } = playingVideo();
    expect(observed.has(video)).toBe(true);
    notify([{ target: video, isIntersecting: false }]);
    expect(pause).toHaveBeenCalledOnce();
    expect(observed.has(video)).toBe(false);
  });

  it("keeps playing while some of it is on screen", () => {
    const { video, pause } = playingVideo();
    notify([{ target: video, isIntersecting: true }]);
    expect(pause).not.toHaveBeenCalled();
  });

  it("keeps playing in picture in picture", () => {
    const { video, pause } = playingVideo();
    Object.defineProperty(document, "pictureInPictureElement", { configurable: true, get: () => video });
    notify([{ target: video, isIntersecting: false }]);
    expect(pause).not.toHaveBeenCalled();
    Reflect.deleteProperty(document, "pictureInPictureElement");
  });

  it("is no longer watched after it ends", () => {
    const { video } = playingVideo();
    video.dispatchEvent(new Event("ended"));
    expect(observed.has(video)).toBe(false);
  });
});
