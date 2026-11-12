/**
 * How the sidebar rows move when the list changes under them (fork FEATURES #73).
 *
 * Two cases, one technique (FLIP: measure where a row was, let the DOM change, measure where it is,
 * and play the difference back to zero on the compositor):
 *
 * - A row that is removed, added or moved by anything but a drag (archive, delete, a new chat, a
 *   menu move): the rows that stay slide to their new places instead of jumping.
 * - A drag that drops: when the drag ends, the rows lose their drag offsets at once, but the new
 *   order arrives only when the host has saved it, a few hundred milliseconds later. In between, the
 *   rows jumped back to the old order and then jumped again to the new one. The rows now stay where
 *   the drop left them (the dropped row under the pointer) until the new order is in the DOM, and
 *   then slide to it.
 *
 * Positions are measured with the row's own animations cancelled and, while a drop settles, with
 * the CSS offset transition off (`data-sidebar-settling` in `app-shell.css`), so a measurement is
 * always the layout position.
 */

import { prefersReducedMotion } from "../../utils";

const ROW_SELECTOR = "[data-chat-id]";
/** How long a row takes to slide to its new place. */
export const SIDEBAR_ROW_SLIDE_MS = 200;
/** The longest a drop holds the rows before it settles on whatever order the list has then. */
export const SIDEBAR_DROP_HOLD_MS = 900;
const SLIDE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * The vertical distance each element must be drawn back by so that it shows where it was. Elements
 * that were not there before, or that did not move by at least half a pixel, are left out.
 */
export function rowSlideDeltas<K>(before: Map<K, number>, after: Map<K, number>): Map<K, number> {
  const deltas = new Map<K, number>();
  for (const [key, top] of after) {
    const previous = before.get(key);
    if (previous === undefined) continue;
    const delta = previous - top;
    if (Math.abs(delta) >= 0.5) deltas.set(key, delta);
  }
  return deltas;
}

/** Whether two id orders differ. */
export function rowOrderChanged(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length) return true;
  return before.some((id, index) => after[index] !== id);
}

/**
 * A row that moves to another section is a new element there. It takes the place of the element
 * with its chat id that left the list, so it slides from where that one was.
 */
function carryOver(before: Map<HTMLElement, number>, now: Map<HTMLElement, number>): Map<HTMLElement, number> {
  const gone = new Map<string, number>();
  for (const [row, top] of before) {
    const chatId = row.dataset.chatId;
    if (!row.isConnected && chatId && !gone.has(chatId)) gone.set(chatId, top);
  }
  if (gone.size === 0) return before;
  const merged = new Map(before);
  for (const row of now.keys()) {
    const chatId = row.dataset.chatId;
    const top = chatId ? gone.get(chatId) : undefined;
    if (!merged.has(row) && top !== undefined) merged.set(row, top);
  }
  return merged;
}

export interface SidebarDropSettle {
  /** The chat that was dropped. It starts under the pointer. */
  chatId: string;
  /** The pointer's vertical position at the drop, in the viewport. */
  clientY: number;
  /** False when the drop leaves the order as it is: the rows settle at once. */
  expectsChange: boolean;
}

export function createSidebarRowMotion() {
  let list: HTMLElement | undefined;
  let observer: MutationObserver | undefined;
  /** Where each row was at the last measurement, in list content coordinates. */
  let tops = new Map<HTMLElement, number>();
  const animations = new Map<HTMLElement, Animation>();
  let settle: {
    from: Map<HTMLElement, number>;
    order: string[];
    expectsChange: boolean;
    timer: number;
  } | null = null;
  let settleEndTimer: number | null = null;

  function rows(): HTMLElement[] {
    return list ? [...list.querySelectorAll<HTMLElement>(ROW_SELECTOR)] : [];
  }

  function order(): string[] {
    return rows().map((row) => row.dataset.chatId ?? "");
  }

  /** Content coordinates do not change when the list scrolls. */
  function contentTop(row: HTMLElement): number {
    if (!list) return 0;
    return row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
  }

  function stopAnimation(row: HTMLElement): void {
    animations.get(row)?.cancel();
    animations.delete(row);
  }

  /** Layout positions: each row's running slide is cancelled first. */
  function measure(): Map<HTMLElement, number> {
    const next = new Map<HTMLElement, number>();
    for (const row of rows()) {
      stopAnimation(row);
      next.set(row, contentTop(row));
    }
    return next;
  }

  /** Visual positions: drag offsets and running slides included. */
  function measureVisual(): Map<HTMLElement, number> {
    const next = new Map<HTMLElement, number>();
    for (const row of rows()) next.set(row, contentTop(row));
    return next;
  }

  function slide(deltas: Map<HTMLElement, number>): void {
    if (prefersReducedMotion()) return;
    for (const [row, delta] of deltas) {
      if (typeof row.animate !== "function") continue;
      const animation = row.animate([{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: "none" }], {
        duration: SIDEBAR_ROW_SLIDE_MS,
        easing: SLIDE_EASING,
      });
      animations.set(row, animation);
      animation.onfinish = () => {
        if (animations.get(row) === animation) animations.delete(row);
      };
    }
  }

  function hold(deltas: Map<HTMLElement, number>): void {
    for (const [row, delta] of deltas) {
      if (typeof row.animate !== "function") continue;
      const transform = `translate3d(0, ${delta}px, 0)`;
      animations.set(
        row,
        row.animate([{ transform }, { transform }], { duration: SIDEBAR_DROP_HOLD_MS * 2, fill: "forwards" }),
      );
    }
  }

  function observe(withAttributes: boolean): void {
    if (!list || !observer) return;
    observer.disconnect();
    observer.observe(
      list,
      withAttributes
        ? { attributes: true, attributeFilter: ["class", "style"], childList: true, subtree: true }
        : { childList: true, subtree: true },
    );
  }

  function finishSettle(): void {
    if (!settle) return;
    const from = settle.from;
    clearTimeout(settle.timer);
    settle = null;
    const now = measure();
    slide(rowSlideDeltas(carryOver(from, now), now));
    tops = now;
    observe(false);
    if (settleEndTimer !== null) clearTimeout(settleEndTimer);
    // The offset transition comes back once the rows are in place.
    settleEndTimer = window.setTimeout(() => {
      settleEndTimer = null;
      list?.removeAttribute("data-sidebar-settling");
    }, SIDEBAR_ROW_SLIDE_MS);
  }

  function onMutations(records: MutationRecord[]): void {
    if (!list) return;
    if (settle) {
      if (!settle.expectsChange || rowOrderChanged(settle.order, order())) {
        finishSettle();
        return;
      }
      // The drag offsets are gone but the new order is not in yet: keep every row where it was.
      const now = measure();
      hold(rowSlideDeltas(settle.from, now));
      return;
    }
    const rowsChanged = records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(
        (node) => node instanceof HTMLElement && (node.matches(ROW_SELECTOR) || node.querySelector(ROW_SELECTOR)),
      ),
    );
    const now = measure();
    if (rowsChanged) slide(rowSlideDeltas(carryOver(tops, now), now));
    tops = now;
  }

  /** Measures again after something that moves rows without adding or removing one (a folder opening). */
  function remember(): void {
    if (!list || settle) return;
    tops = measure();
  }

  function attach(element: HTMLElement): () => void {
    detach();
    list = element;
    if (typeof MutationObserver === "undefined") return detach;
    observer = new MutationObserver(onMutations);
    observe(false);
    tops = measure();
    element.addEventListener("transitionend", remember);
    element.addEventListener("pointerdown", remember, true);
    element.addEventListener("contextmenu", remember, true);
    return detach;
  }

  function detach(): void {
    observer?.disconnect();
    observer = undefined;
    if (settle) clearTimeout(settle.timer);
    settle = null;
    if (settleEndTimer !== null) clearTimeout(settleEndTimer);
    settleEndTimer = null;
    for (const row of [...animations.keys()]) stopAnimation(row);
    if (list) {
      list.removeEventListener("transitionend", remember);
      list.removeEventListener("pointerdown", remember, true);
      list.removeEventListener("contextmenu", remember, true);
      list.removeAttribute("data-sidebar-settling");
    }
    list = undefined;
  }

  /**
   * Call on drop, before the drag state is reset and before the drop is committed: it reads the
   * rows where the drag shows them.
   */
  function beginDropSettle(drop: SidebarDropSettle): void {
    if (!list || !observer || prefersReducedMotion()) return;
    const from = measureVisual();
    const dropped = rows().find((row) => row.dataset.chatId === drop.chatId && row.closest("[data-section-id]"));
    if (dropped) {
      const height = dropped.getBoundingClientRect().height;
      const bounds = list.getBoundingClientRect();
      const top = Math.min(Math.max(drop.clientY - height / 2, bounds.top), bounds.bottom - height);
      from.set(dropped, top - bounds.top + list.scrollTop);
    }
    if (settle) clearTimeout(settle.timer);
    if (settleEndTimer !== null) clearTimeout(settleEndTimer);
    settleEndTimer = null;
    list.setAttribute("data-sidebar-settling", "");
    settle = {
      from,
      order: order(),
      expectsChange: drop.expectsChange,
      timer: window.setTimeout(finishSettle, SIDEBAR_DROP_HOLD_MS),
    };
    observe(true);
  }

  return { attach, beginDropSettle, detach };
}
