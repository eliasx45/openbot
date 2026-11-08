/**
 * Fork (docs/fork/FEATURES.md, "Review cards"). The clip of a form field: the part of a video that
 * the question is about, played in a loop. The person pauses it and adds a note at the frame on
 * screen; the agent gets the note with that frame.
 */
import { readUiFormClipNote, type UiFormClip as UiFormClipSpec } from "@openbot/contracts/ui-blocks";
import { Button, Input, Pin, X } from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../../text";

/** `m:ss.cc`, as an editor reads a time. */
function clipTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

export interface UiFormClipProps {
  clip: UiFormClipSpec;
  /** The notes as the response holds them (`uiFormClipNoteValue`). */
  notes: readonly string[];
  locked: boolean;
  onAdd: (time: number, text: string) => void;
  onRemove: (index: number) => void;
}

export function UiFormClip(props: UiFormClipProps) {
  const { t } = useText();
  let video: HTMLVideoElement | undefined;
  const [noteAt, setNoteAt] = createSignal<{ time: number } | null>(null);
  const [text, setText] = createSignal("");
  const start = () => props.clip.start ?? 0;

  function keepInRange(): void {
    if (!video) return;
    const end = props.clip.end;
    if (video.currentTime < start() - 0.05 || (end !== undefined && video.currentTime >= end)) {
      const playing = !video.paused;
      video.currentTime = start();
      if (playing) void video.play().catch(() => undefined);
    }
  }

  function openNote(): void {
    if (!video) return;
    video.pause();
    setNoteAt({ time: video.currentTime });
    setText("");
  }

  function addNote(): void {
    const at = noteAt();
    const words = text().trim();
    if (at === null || !words) return;
    props.onAdd(at.time, words);
    setNoteAt(null);
    setText("");
  }

  return (
    <div class="ui-block-clip">
      <Show when={props.clip.src}>
        {(src) => (
          <video
            ref={(element) => {
              video = element;
            }}
            class="ui-block-clip-video"
            src={src()}
            controls
            playsinline
            preload="metadata"
            onLoadedMetadata={() => {
              if (video) video.currentTime = start();
            }}
            onTimeUpdate={keepInRange}
            onSeeked={keepInRange}
          >
            <track kind="captions" />
          </video>
        )}
      </Show>
      <Show when={props.notes.length > 0}>
        <ul class="ui-block-clip-notes">
          <For each={props.notes}>
            {(value, index) => {
              const note = readUiFormClipNote(value);
              return (
                <li class="ui-block-clip-note">
                  <Pin aria-hidden="true" />
                  <span class="ui-block-clip-note-time">{clipTime(note?.time ?? 0)}</span>
                  <span class="ui-block-clip-note-text">{note?.text ?? value}</span>
                  <Show when={!props.locked}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("uiBlock.clip.removeNote")}
                      onClick={() => props.onRemove(index())}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={!props.locked}>
        <Show
          when={noteAt()}
          keyed
          fallback={
            <Button type="button" variant="ghost" size="sm" class="ui-block-clip-add" onClick={openNote}>
              <Pin aria-hidden="true" />
              {t("uiBlock.clip.note")}
            </Button>
          }
        >
          {(at) => (
            <div class="ui-block-clip-draft">
              <span class="ui-block-clip-note-time">{clipTime(at.time)}</span>
              <Input
                value={text()}
                autofocus
                placeholder={t("uiBlock.clip.notePlaceholder")}
                onValueChange={setText}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addNote();
                  } else if (event.key === "Escape") setNoteAt(null);
                }}
              />
              <Button type="button" size="sm" disabled={!text().trim()} onClick={addNote}>
                {t("uiBlock.clip.addNote")}
              </Button>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
