// Fork (docs/fork/FEATURES.md, "Video speed"): − and + step through fixed speeds and stop at the ends.
import {
  fasterPlaybackSpeed,
  isFastestPlaybackSpeed,
  isSlowestPlaybackSpeed,
  NORMAL_PLAYBACK_SPEED,
  PLAYBACK_SPEEDS,
  slowerPlaybackSpeed,
} from "@openbot/ui/features/conversation/playback-speed";
import { expect, it } from "vitest";

it("has the steps 0.5 to 3, with 1 as the normal speed", () => {
  expect(PLAYBACK_SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
  expect(NORMAL_PLAYBACK_SPEED).toBe(1);
});

it("steps up one speed at a time and stays at 3", () => {
  const seen: number[] = [];
  let rate = NORMAL_PLAYBACK_SPEED;
  for (let click = 0; click < 8; click += 1) {
    rate = fasterPlaybackSpeed(rate);
    seen.push(rate);
  }
  expect(seen).toEqual([1.25, 1.5, 1.75, 2, 2.5, 3, 3, 3]);
  expect(isFastestPlaybackSpeed(3)).toBe(true);
  expect(isFastestPlaybackSpeed(2.5)).toBe(false);
});

it("steps down one speed at a time and stays at 0.5", () => {
  const seen: number[] = [];
  let rate = NORMAL_PLAYBACK_SPEED;
  for (let click = 0; click < 4; click += 1) {
    rate = slowerPlaybackSpeed(rate);
    seen.push(rate);
  }
  expect(seen).toEqual([0.75, 0.5, 0.5, 0.5]);
  expect(isSlowestPlaybackSpeed(0.5)).toBe(true);
  expect(isSlowestPlaybackSpeed(0.75)).toBe(false);
});

it("moves a speed between steps to the nearest step in the direction of the click", () => {
  expect(fasterPlaybackSpeed(1.1)).toBe(1.25);
  expect(slowerPlaybackSpeed(1.1)).toBe(1);
  // A rate that the browser rounded counts as its step.
  expect(fasterPlaybackSpeed(1.2500001)).toBe(1.5);
  expect(slowerPlaybackSpeed(0.7500001)).toBe(0.5);
  // Out of range: back to the nearest end.
  expect(fasterPlaybackSpeed(4)).toBe(3);
  expect(slowerPlaybackSpeed(0.25)).toBe(0.5);
});
