import { Tooltip } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createStore, onSettled, Show } from "solid-js";
import { useText } from "../../text";

/** One page of a document, as a picture, for the peek over its file chip. */
export interface FileChipPeek {
  /** A `data:` image of the page. */
  imageUrl: string;
  /** The page that the picture shows, from 1. */
  page: number;
  pageCount: number;
  /** The picture size in pixels, so the peek keeps the page shape before the image decodes. */
  width: number;
  height: number;
}

/** The hover time before the peek opens, as the Learn PDF peek in Ghostex. */
const OPEN_DELAY = 300;
/** The peek stays this long after the pointer leaves, so a short slip off the chip does not close it. */
const CLOSE_DELAY = 250;

/**
 * A frosted peek over a file chip that shows one page of the file and the page count. It opens on
 * hover after a short time, and on keyboard focus. It closes when the pointer or the focus leaves,
 * or on a click, so the click opens the file as before. The page is read when the peek first
 * opens. A close before the answer stops the read. A file that does not show gets no peek again.
 */
export function FilePagePeek(props: {
  name: string;
  load: (signal: AbortSignal) => Promise<FileChipPeek | null>;
  children: JSX.Element;
}): JSX.Element {
  const { t } = useText();
  const [peek, setPeek] = createStore<{ open: boolean; page: FileChipPeek | null; failed: boolean }>({
    open: false,
    page: null,
    failed: false,
  });
  let reading: AbortController | undefined;

  const stopReading = () => {
    reading?.abort();
    reading = undefined;
  };
  const show = (open: boolean) => {
    if (!open) {
      stopReading();
      setPeek((state) => {
        state.open = false;
      });
      return;
    }
    if (peek.failed) return;
    setPeek((state) => {
      state.open = true;
    });
    if (peek.page || reading) return;
    const current = new AbortController();
    reading = current;
    const finish = (page: FileChipPeek | null) => {
      if (current.signal.aborted) return;
      reading = undefined;
      setPeek((state) => {
        state.page = page;
        state.failed = page === null;
        if (!page) state.open = false;
      });
    };
    void props.load(current.signal).then(finish, () => finish(null));
  };
  onSettled(() => stopReading);

  return (
    <Tooltip.Root
      open={peek.open}
      onOpenChange={show}
      placement="top"
      gutter={8}
      openDelay={OPEN_DELAY}
      closeDelay={CLOSE_DELAY}
    >
      <Tooltip.Trigger
        as="span"
        class="message-file-peek-trigger"
        // The chip inside takes the focus. Only a keyboard focus opens the peek, not a click.
        onFocusIn={(event: FocusEvent) => {
          if (event.target instanceof Element && event.target.matches(":focus-visible")) show(true);
        }}
        onFocusOut={() => show(false)}
      >
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="message-file-peek">
          <Show when={peek.page} fallback={<span class="message-file-peek-page" data-loading="" />}>
            {(page) => (
              <>
                <img
                  class="message-file-peek-page"
                  src={page().imageUrl}
                  alt={props.name}
                  width={page().width}
                  height={page().height}
                />
                <span class="message-file-peek-count">
                  {t("chat.file.pagePeek", { page: page().page, total: page().pageCount })}
                </span>
              </>
            )}
          </Show>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
