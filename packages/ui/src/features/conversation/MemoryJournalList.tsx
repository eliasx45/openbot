// Fork (docs/fork/FEATURES.md, "Memory"): the history of an agent's memories, with Undo.

import type { AgentMemoryJournalEntry } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button } from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";

const KIND_TEXT = {
  created: "memory.journal.created",
  edited: "memory.journal.edited",
  deleted: "memory.journal.deleted",
} as const satisfies Record<AgentMemoryJournalEntry["kind"], AppTextKey>;

const ACTOR_TEXT = {
  agent: "memory.journal.by.agent",
  user: "memory.journal.by.user",
  review: "memory.journal.by.review",
  tidy: "memory.journal.by.tidy",
  undo: "memory.journal.by.undo",
} as const satisfies Record<AgentMemoryJournalEntry["actor"], AppTextKey>;

export interface MemoryJournalListProps {
  entries: readonly AgentMemoryJournalEntry[];
  /** The id of the change whose undo runs now. */
  undoingId: string | null;
  onUndo: (entry: AgentMemoryJournalEntry) => void;
}

export function MemoryJournalList(props: MemoryJournalListProps) {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  return (
    <section class="memory-journal" aria-label={t("memory.journal.title")}>
      <div class="memory-journal-header">
        <h3 class="memory-journal-title">{t("memory.journal.title")}</h3>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open())}>
          {open() ? t("memory.journal.hide") : t("memory.journal.show")}
        </Button>
      </div>
      <Show when={open()}>
        <p class="agent-memories-meta">{t("memory.journal.hint")}</p>
        <Show when={props.entries.length > 0} fallback={<p class="agent-memory-state">{t("memory.journal.empty")}</p>}>
          <ul class="memory-journal-list">
            <For each={props.entries}>
              {(entry) => (
                <li class="memory-journal-row">
                  <div class="memory-journal-text">
                    <p class="agent-memories-meta">
                      {t(KIND_TEXT[entry.kind])} {t(ACTOR_TEXT[entry.actor])} · {journalDate(entry.at)}
                    </p>
                    <Show when={entry.kind === "edited" && entry.before}>
                      {(before) => <p class="memory-journal-before">{before()}</p>}
                    </Show>
                    <p class="memory-journal-after">{entry.after ?? entry.before}</p>
                  </div>
                  <Show
                    when={!entry.undone}
                    fallback={<span class="agent-memories-meta">{t("memory.journal.undone")}</span>}
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={props.undoingId === entry.id}
                      disabled={props.undoingId !== null}
                      onClick={() => props.onUndo(entry)}
                    >
                      {t("memory.journal.undo")}
                    </Button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

function journalDate(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
