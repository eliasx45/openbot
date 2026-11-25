/**
 * Fork (docs/fork/FEATURES.md #115). Which way the reader last moved the chat by hand (wheel, key,
 * touch), so a scroll event can tell the reader's move from one the chat made itself.
 *
 * A move counts as the reader's within `READER_INPUT_WINDOW_MS` of the input, and also until
 * `READER_INPUT_FRAMES` frames have run after it. The scroll that a wheel or a key causes reaches the
 * page in one of the next frames, however late those frames come: a busy renderer or a window whose
 * frames are held back fires it more than the window's 250 ms after the input. With the time alone,
 * such a move up was not the reader's, so the chat kept following the latest message and pulled the
 * reader back to the bottom at the next update of a running turn.
 */
export const READER_INPUT_WINDOW_MS = 250;
export const READER_INPUT_FRAMES = 3;

export interface ReaderScrollIntent {
  up: boolean;
  /** Milliseconds since the input. */
  age: number;
}

export interface ReaderScrollIntentClock {
  now: () => number;
  /** Runs `run` at the next frame; returns a function that cancels it. */
  requestFrame: (run: () => void) => () => void;
}

export function createReaderScrollIntent(clock: ReaderScrollIntentClock) {
  let last: { up: boolean; at: number; framesLeft: number } | undefined;
  let cancelFrame: (() => void) | undefined;

  const countFrame = (): void => {
    cancelFrame = undefined;
    if (!last || last.framesLeft <= 0) return;
    last.framesLeft -= 1;
    if (last.framesLeft > 0) cancelFrame = clock.requestFrame(countFrame);
  };

  return {
    note(up: boolean): void {
      last = { up, at: clock.now(), framesLeft: READER_INPUT_FRAMES };
      cancelFrame ??= clock.requestFrame(countFrame);
    },
    /** The reader's last input when a scroll now is still its effect, else null. */
    current(): ReaderScrollIntent | null {
      if (!last) return null;
      const age = clock.now() - last.at;
      return age < READER_INPUT_WINDOW_MS || last.framesLeft > 0 ? { up: last.up, age } : null;
    },
    /** Milliseconds since the last input, for the scroll log. */
    age(): number | undefined {
      return last ? Math.round(clock.now() - last.at) : undefined;
    },
    dispose(): void {
      cancelFrame?.();
      cancelFrame = undefined;
    },
  };
}
