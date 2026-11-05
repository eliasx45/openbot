import type { SelectionNote } from "@openbot/contracts/selection-instruction";
import { Button, Input } from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { CloseIcon } from "./ConversationIcons";

/**
 * Fork: the notes about selected text that wait above the message box. Each one shows the start of
 * its quote and its note. A click on the note edits it, and × removes it. They go with the next send.
 */
export function ComposerSelectionNotes(props: {
  notes: readonly SelectionNote[];
  disabled?: boolean | undefined;
  onRemove: (id: string) => void;
  onEdit: (id: string, note: string) => void;
}) {
  const { t } = useText();
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editText, setEditText] = createSignal("");

  const startEdit = (item: SelectionNote) => {
    setEditText(item.note);
    setEditingId(item.id);
  };
  const finishEdit = (save: boolean) => {
    const id = editingId();
    if (!id) return;
    setEditingId(null);
    if (save) props.onEdit(id, editText());
  };

  return (
    <section class="composer-selection-notes" aria-label={t("composer.notes.label")}>
      <span class="composer-selection-notes-count">{t("composer.notes.count", { count: props.notes.length })}</span>
      <ul>
        <For each={props.notes} keyed={(item) => item.id}>
          {(item) => (
            <li class="composer-selection-note">
              <div>
                <q>{item().quote}</q>
                <Show
                  when={editingId() === item().id}
                  fallback={
                    <Button
                      variant="ghost"
                      type="button"
                      class="composer-selection-note-text"
                      aria-label={t("composer.notes.edit")}
                      title={t("composer.notes.edit")}
                      disabled={props.disabled}
                      onClick={() => startEdit(item())}
                    >
                      {item().note}
                    </Button>
                  }
                >
                  <Input
                    size="sm"
                    value={editText()}
                    aria-label={t("composer.notes.edit")}
                    ref={(element) => requestAnimationFrame(() => element.focus({ preventScroll: true }))}
                    onValueChange={setEditText}
                    onBlur={() => finishEdit(true)}
                    onKeyDown={(event) => {
                      if (event.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        finishEdit(true);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        finishEdit(false);
                      }
                    }}
                  />
                </Show>
              </div>
              <Button
                variant="ghost"
                type="button"
                aria-label={t("composer.notes.remove")}
                disabled={props.disabled}
                onClick={() => props.onRemove(item().id)}
              >
                <CloseIcon />
              </Button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
