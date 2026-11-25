import { describe, expect, it } from "vitest";
import {
  createReaderScrollIntent,
  READER_INPUT_FRAMES,
  READER_INPUT_WINDOW_MS,
} from "./features/conversation/reader-scroll-intent";

// Fork (docs/fork/FEATURES.md #115): a scroll up that the reader made must count as the reader's when
// its scroll event lands late, or the chat keeps following the latest message and pulls the reader back.
function clock() {
  let now = 0;
  const frames: (() => void)[] = [];
  return {
    clock: {
      now: () => now,
      requestFrame: (run: () => void) => {
        frames.push(run);
        return () => {
          const index = frames.indexOf(run);
          if (index >= 0) frames.splice(index, 1);
        };
      },
    },
    advance(ms: number) {
      now += ms;
    },
    frame() {
      const due = frames.splice(0);
      for (const run of due) run();
    },
  };
}

describe("reader scroll intent", () => {
  it("counts a wheel whose scroll lands 400 ms later, before the next frames ran", () => {
    const time = clock();
    const intent = createReaderScrollIntent(time.clock);
    intent.note(true);
    time.advance(400);
    expect(intent.current()).toEqual({ up: true, age: 400 });
  });

  it("counts a scroll in the frame after the input, however late that frame is", () => {
    const time = clock();
    const intent = createReaderScrollIntent(time.clock);
    intent.note(true);
    time.frame();
    time.advance(2_000);
    expect(intent.current()?.up).toBe(true);
  });

  it("stops counting once the frames ran and the time is over", () => {
    const time = clock();
    const intent = createReaderScrollIntent(time.clock);
    intent.note(true);
    for (let frame = 0; frame < READER_INPUT_FRAMES; frame += 1) time.frame();
    time.advance(READER_INPUT_WINDOW_MS);
    expect(intent.current()).toBeNull();
  });

  it("keeps the time window after the frames, for a gesture's further scroll events", () => {
    const time = clock();
    const intent = createReaderScrollIntent(time.clock);
    intent.note(false);
    for (let frame = 0; frame < READER_INPUT_FRAMES; frame += 1) time.frame();
    time.advance(READER_INPUT_WINDOW_MS - 1);
    expect(intent.current()).toEqual({ up: false, age: READER_INPUT_WINDOW_MS - 1 });
  });

  it("a new input restarts the count and takes its direction", () => {
    const time = clock();
    const intent = createReaderScrollIntent(time.clock);
    intent.note(true);
    time.frame();
    time.frame();
    intent.note(false);
    time.frame();
    time.advance(1_000);
    expect(intent.current()?.up).toBe(false);
    time.frame();
    time.frame();
    expect(intent.current()).toBeNull();
  });

  it("has no intent before any input", () => {
    const intent = createReaderScrollIntent(clock().clock);
    expect(intent.current()).toBeNull();
    expect(intent.age()).toBeUndefined();
  });
});
