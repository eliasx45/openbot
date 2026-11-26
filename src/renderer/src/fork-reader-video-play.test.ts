// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { watchReaderVideoPlay } from "./features/conversation/reader-video-play";

// Fork (docs/fork/FEATURES.md #120): starting a video in the chat stops the chat from following new output.
describe("a video the reader starts in the chat", () => {
  it("tells the chat once per play, for a video at any depth, and not for audio or after cleanup", () => {
    const chat = document.createElement("div");
    const row = document.createElement("div");
    const video = document.createElement("video");
    const audio = document.createElement("audio");
    row.append(video, audio);
    chat.append(row);
    document.body.append(chat);
    const onPlay = vi.fn();
    const stop = watchReaderVideoPlay(chat, onPlay);

    video.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(video);

    audio.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledTimes(1);

    const outside = document.createElement("video");
    document.body.append(outside);
    outside.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledTimes(1);

    stop();
    video.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
