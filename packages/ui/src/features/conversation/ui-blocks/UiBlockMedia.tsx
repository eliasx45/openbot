/**
 * Fork (docs/fork/FEATURES.md, "Card media"). The videos and images that a block is about, under its
 * title: a video plays with its sound and controls, `start`..`end` in a loop; an image opens in the
 * image viewer. A file the host could not attach, or one this client cannot open, shows as its name.
 */
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { type UiBlockMedia, uiBlockMediaKind, uiBlockMediaName } from "@openbot/contracts/ui-blocks";
import { Button, FileX } from "@openbot/ui";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { useText } from "../../../text";
import { ImageLightbox, type ImageLightboxOpening } from "../ImageLightbox";

/**
 * Keeps a video inside `start`..`end`: a seek before the start or play past the end goes back to the
 * start, and a playing video goes on, so the range loops. The review clips of a form use it too.
 */
export function keepVideoInRange(video: HTMLVideoElement, start: number, end: number | undefined): void {
  if (video.currentTime < start - 0.05 || (end !== undefined && video.currentTime >= end)) {
    const playing = !video.paused;
    video.currentTime = start;
    if (playing) void video.play().catch(() => undefined);
  }
}

function imageSummary(item: UiBlockMedia, src: string): AttachmentSummary {
  const name = uiBlockMediaName(item.path);
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "png";
  return {
    id: src.split("/").at(-1) ?? name,
    name,
    size: 0,
    kind: "image",
    mimeType: `image/${extension === "jpg" ? "jpeg" : extension}`,
    previewKind: "image",
    previewUrl: src,
  };
}

function UiBlockMediaUnavailable(props: { path: string }) {
  const { t } = useText();
  return (
    <p class="ui-block-media-unavailable" title={props.path}>
      <FileX aria-hidden="true" />
      <span>{t("uiBlock.media.unavailable", { name: uiBlockMediaName(props.path) })}</span>
    </p>
  );
}

function UiBlockMediaVideo(props: { item: UiBlockMedia; src: string; onFail: () => void }) {
  let video: HTMLVideoElement | undefined;
  const start = () => props.item.start ?? 0;
  return (
    <video
      ref={(element) => {
        video = element;
      }}
      class="ui-block-media-video"
      src={props.src}
      controls
      playsinline
      preload="metadata"
      aria-label={props.item.caption ?? uiBlockMediaName(props.item.path)}
      onLoadedMetadata={() => {
        if (video && start() > 0) video.currentTime = start();
      }}
      onTimeUpdate={() => video && keepVideoInRange(video, start(), props.item.end)}
      onSeeked={() => video && keepVideoInRange(video, start(), props.item.end)}
      onError={() => props.onFail()}
    >
      <track kind="captions" />
    </video>
  );
}

export function UiBlockMediaStrip(props: { media?: readonly UiBlockMedia[] | undefined }) {
  const { t } = useText();
  const [failed, setFailed] = createSignal<ReadonlySet<number>>(new Set());
  const [opening, setOpening] = createSignal<ImageLightboxOpening | null>(null);
  const fail = (index: number) => setFailed((current) => new Set([...current, index]));
  const images = () =>
    (props.media ?? []).flatMap((item, index) =>
      item.src && uiBlockMediaKind(item.path) === "image" && !failed().has(index)
        ? [{ index, summary: imageSummary(item, item.src) }]
        : [],
    );
  const openImage = (index: number, origin: HTMLElement) => {
    const shown = images();
    const at = shown.findIndex((image) => image.index === index);
    if (at >= 0) setOpening({ images: shown.map((image) => image.summary), index: at, origin });
  };
  return (
    <Show when={props.media?.length}>
      <div class="ui-block-media" data-count={props.media?.length}>
        <For each={props.media}>
          {(item, index) => (
            <figure class="ui-block-media-item" data-kind={uiBlockMediaKind(item.path) ?? undefined}>
              <Show when={!failed().has(index()) && item.src} fallback={<UiBlockMediaUnavailable path={item.path} />}>
                {(src) => (
                  <Switch>
                    <Match when={uiBlockMediaKind(item.path) === "video"}>
                      <UiBlockMediaVideo item={item} src={src()} onFail={() => fail(index())} />
                    </Match>
                    <Match when={uiBlockMediaKind(item.path) === "image"}>
                      <Button
                        type="button"
                        variant="ghost"
                        class="ui-block-media-image"
                        aria-label={t("uiBlock.media.enlarge", { name: uiBlockMediaName(item.path) })}
                        onClick={(event) => openImage(index(), event.currentTarget)}
                      >
                        <img
                          src={src()}
                          alt={item.caption ?? uiBlockMediaName(item.path)}
                          onError={() => fail(index())}
                        />
                      </Button>
                    </Match>
                  </Switch>
                )}
              </Show>
              <Show when={item.caption}>
                <figcaption class="ui-block-media-caption">{item.caption}</figcaption>
              </Show>
            </figure>
          )}
        </For>
      </div>
      <Show when={opening()}>{(open) => <ImageLightbox opening={open()} onClose={() => setOpening(null)} />}</Show>
    </Show>
  );
}
