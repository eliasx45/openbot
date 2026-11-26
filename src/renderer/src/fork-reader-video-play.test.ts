// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchReaderMediaPlay } from "./features/conversation/reader-video-play";

function setUserActivation(active: boolean | undefined) {
  if (active === undefined) Reflect.deleteProperty(navigator, "userActivation");
  else Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: active } });
}

function chatWith(...media: HTMLMediaElement[]) {
  const chat = document.createElement("div");
  const row = document.createElement("div");
  row.append(...media);
  chat.append(row);
  document.body.append(chat);
  const onPlay = vi.fn();
  const stop = watchReaderMediaPlay(chat, onPlay);
  return { chat, onPlay, stop };
}

afterEach(() => {
  setUserActivation(undefined);
  document.body.replaceChildren();
});

// Fork (docs/fork/FEATURES.md #120): starting a video in the chat stops the chat from following new output.
describe("a video the reader starts in the chat", () => {
  it("tells the chat once per play, for a video at any depth, and not outside the chat or after cleanup", () => {
    const video = document.createElement("video");
    const { onPlay, stop } = chatWith(video);

    video.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(video);

    const outside = document.createElement("video");
    document.body.append(outside);
    outside.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledTimes(1);

    stop();
    video.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  // Fork #121: an audio file in a row stops as well when the virtual list drops the row.
  it("holds the chat for an audio file the reader plays", () => {
    const audio = document.createElement("audio");
    const { onPlay } = chatWith(audio);
    audio.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledWith(audio);
  });

  // Fork #121: only a play the reader started holds the chat.
  it("does not hold the chat for a muted clip that plays by itself, and does when the reader starts it", () => {
    const clip = document.createElement("video");
    clip.muted = true;
    clip.loop = true;
    clip.autoplay = true;
    const silent = document.createElement("video");
    silent.volume = 0;
    const { onPlay } = chatWith(clip, silent);

    setUserActivation(false);
    clip.dispatchEvent(new Event("play"));
    silent.dispatchEvent(new Event("play"));
    expect(onPlay).not.toHaveBeenCalled();

    // The same clip after a click or key on it: the reader started it.
    setUserActivation(true);
    clip.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledWith(clip);
  });

  it("holds the chat for a video with sound that plays once its file has loaded after the reader's click", () => {
    const video = document.createElement("video");
    video.autoplay = true;
    const { onPlay } = chatWith(video);
    setUserActivation(false);
    video.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledWith(video);
  });
});
