import { createSignal, Show } from "solid-js";

export function MediaFilePreview(props: {
  kind: "audio" | "video" | null;
  src: string;
  name: string;
  class?: string;
  preload?: "none" | "metadata";
  /** Plays at once: the user asked for it with the click that loaded the file. */
  autoplay?: boolean;
}) {
  /*
   * Fork: a paused video shows Chromium's controls over the lower part of the picture, which on a wide
   * before/after video is most of it (Elias, 8 Nov 2026). They show while the pointer or the focus
   * is on the video.
   */
  const [controlsShown, setControlsShown] = createSignal(Boolean(props.autoplay));
  return (
    <>
      <Show when={props.kind === "audio"}>
        <audio
          class={props.class}
          controls
          autoplay={props.autoplay}
          preload={props.preload}
          src={props.src}
          aria-label={props.name}
        >
          {/* Local files do not provide caption tracks. */}
          <track kind="captions" />
        </audio>
      </Show>
      <Show when={props.kind === "video"}>
        <video
          class={props.class}
          controls={controlsShown()}
          onPointerEnter={() => setControlsShown(true)}
          onPointerLeave={(event) => {
            if (document.activeElement !== event.currentTarget) setControlsShown(false);
          }}
          onFocus={() => setControlsShown(true)}
          onBlur={() => setControlsShown(false)}
          playsinline
          autoplay={props.autoplay}
          preload={props.preload}
          src={props.src}
          aria-label={props.name}
        >
          <track kind="captions" />
        </video>
      </Show>
    </>
  );
}
