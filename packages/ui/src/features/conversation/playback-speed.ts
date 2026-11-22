/** The speeds that − and + step through, slowest first. */
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/** The speed that a click on the readout sets again. */
export const NORMAL_PLAYBACK_SPEED = 1;

// A rate from the browser can differ from a step by a rounding error.
const TOLERANCE = 0.001;

const SLOWEST = PLAYBACK_SPEEDS[0];
const FASTEST = PLAYBACK_SPEEDS[8];

/** The next step above `rate`. The fastest step stays. A rate between steps goes to the step above it. */
export function fasterPlaybackSpeed(rate: number): number {
  return PLAYBACK_SPEEDS.find((step) => step > rate + TOLERANCE) ?? FASTEST;
}

/** The next step below `rate`. The slowest step stays. A rate between steps goes to the step below it. */
export function slowerPlaybackSpeed(rate: number): number {
  return PLAYBACK_SPEEDS.findLast((step) => step < rate - TOLERANCE) ?? SLOWEST;
}

export function isFastestPlaybackSpeed(rate: number): boolean {
  return rate >= FASTEST - TOLERANCE;
}

export function isSlowestPlaybackSpeed(rate: number): boolean {
  return rate <= SLOWEST + TOLERANCE;
}
