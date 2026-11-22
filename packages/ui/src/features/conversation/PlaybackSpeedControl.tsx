import { Button, Minus, Plus } from "@openbot/ui";
import { createEffect, createSignal } from "solid-js";
import { useText } from "../../text";
import {
  fasterPlaybackSpeed,
  isFastestPlaybackSpeed,
  isSlowestPlaybackSpeed,
  NORMAL_PLAYBACK_SPEED,
  slowerPlaybackSpeed,
} from "./playback-speed";

/**
 * Fork: − · speed · + for a video. The rate lives on the video element, so every control of the same
 * video (the title line, the full screen bar) shows the same speed, and full screen keeps it. A click
 * here never reaches the player or the chat under it, so it does not play, pause or open full screen.
 */
export function PlaybackSpeedControl(props: { video: HTMLVideoElement | undefined; class?: string | undefined }) {
  const { t, format } = useText();
  const [rate, setRate] = createSignal(NORMAL_PLAYBACK_SPEED);
  createEffect(
    () => props.video,
    (video) => {
      if (!video) return;
      const read = () => setRate(video.playbackRate);
      read();
      video.addEventListener("ratechange", read);
      return () => video.removeEventListener("ratechange", read);
    },
  );
  // The step starts from the element's rate, not the signal: a fast second click comes before the
  // signal shows the first one.
  const apply = (step: (current: number) => number) => {
    const video = props.video;
    if (!video) return;
    const next = step(video.playbackRate);
    video.playbackRate = next;
    // The element sends `ratechange` later; the readout changes with the click.
    setRate(next);
  };
  // A click here is only for the speed: it does not get to the player (play, pause) or the chat under it.
  const onStep = (step: (current: number) => number) => (event: MouseEvent) => {
    event.stopPropagation();
    apply(step);
  };
  const className = () => ["media-speed", props.class].filter(Boolean).join(" ");

  return (
    <fieldset class={className()} aria-label={t("chat.video.speed")}>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        class="media-speed-step"
        aria-label={t("chat.video.slower")}
        disabled={!props.video || isSlowestPlaybackSpeed(rate())}
        onClick={onStep(slowerPlaybackSpeed)}
      >
        <Minus aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        type="button"
        class="media-speed-value"
        aria-label={t("chat.video.resetSpeed")}
        aria-description={t("chat.video.speedValue", { speed: format.number(rate()) })}
        disabled={!props.video}
        onClick={onStep(() => NORMAL_PLAYBACK_SPEED)}
      >
        {t("chat.video.speedValue", { speed: format.number(rate()) })}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        class="media-speed-step"
        aria-label={t("chat.video.faster")}
        disabled={!props.video || isFastestPlaybackSpeed(rate())}
        onClick={onStep(fasterPlaybackSpeed)}
      >
        <Plus aria-hidden="true" />
      </Button>
    </fieldset>
  );
}
