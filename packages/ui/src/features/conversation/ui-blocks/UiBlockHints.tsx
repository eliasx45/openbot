import { Button, Lightbulb } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../../text";
import { UiMathText } from "./UiMathText";

export interface UiBlockHintsProps {
  hints?: readonly string[] | undefined;
  /** The block waits for its answer. A frozen block keeps the hints the person opened. */
  pending: boolean;
  /** Draws a hint as safe Markdown. Without it a hint is plain text with its math typeset. */
  renderMarkdown?: ((markdown: string) => JSX.Element) | undefined;
}

/**
 * The hints of a block, hidden until the person asks. Each press shows one more, so the person tries
 * first and takes only the help they need.
 */
export function UiBlockHints(props: UiBlockHintsProps) {
  const { t } = useText();
  const [opened, setOpened] = createSignal(0);
  const count = () => props.hints?.length ?? 0;
  const shown = () => props.hints?.slice(0, opened()) ?? [];
  return (
    <Show when={count() > 0 && (props.pending || opened() > 0)}>
      <div class="ui-block-hints">
        <For each={shown()}>
          {(hint, index) => (
            <section class="ui-block-hint" aria-label={t("uiBlock.hint.label", { index: index() + 1, count: count() })}>
              <Show
                when={props.renderMarkdown}
                fallback={
                  <p class="ui-block-hint-text">
                    <UiMathText text={hint} />
                  </p>
                }
              >
                {(render) => render()(hint)}
              </Show>
            </section>
          )}
        </For>
        <Show when={props.pending && opened() < count()}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="ui-block-hint-toggle"
            onClick={() => setOpened((value) => value + 1)}
          >
            <Lightbulb aria-hidden="true" />
            {opened() === 0 ? t("uiBlock.hint.show") : t("uiBlock.hint.next", { index: opened() + 1, count: count() })}
          </Button>
        </Show>
      </div>
    </Show>
  );
}
