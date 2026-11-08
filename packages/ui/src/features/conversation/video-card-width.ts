/**
 * Fork: the width of a video card in a chat. The person drags the corner of any video card, every
 * video card follows, and the width is kept for the next start (Elias, 8 Nov 2026: "resize it
 * (within limits so i dont have to go full screen to see more details").
 */

import { createSignal } from "solid-js";

export const VIDEO_CARD_MIN_WIDTH = 280;
export const VIDEO_CARD_MAX_WIDTH = 1100;
const DEFAULT_WIDTH = 560;
const STORAGE_KEY = "openbot.videoCardWidth";

function clamp(width: number): number {
  return Math.round(Math.min(VIDEO_CARD_MAX_WIDTH, Math.max(VIDEO_CARD_MIN_WIDTH, width)));
}

function readStored(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clamp(value) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

const [width, setStoredWidth] = createSignal(readStored());

/** Every video card and its bubble read the width from one variable on the document. */
function setWidth(next: number): void {
  setStoredWidth(next);
  globalThis.document?.documentElement.style.setProperty("--video-card-width", `${next}px`);
}
setWidth(width());

/**
 * The free side of a card: the side its grip sits on and grows to. A card in a right-aligned bubble
 * (the person's own message) keeps its right edge, so it grows to the left.
 */
export function videoCardFreeSide(card: HTMLElement): "left" | "right" {
  const row = card.closest<HTMLElement>(".message-stack") ?? card.parentElement;
  if (!row) return "right";
  const box = card.getBoundingClientRect();
  const area = row.getBoundingClientRect();
  return area.right - box.right < box.left - area.left ? "left" : "right";
}

/**
 * Starts a drag on a video card's grip. Only the horizontal move counts: dragging away from the card
 * grows it, toward it shrinks it, and the height follows the video. The chat column still caps it.
 */
export function startVideoCardResize(event: PointerEvent & { currentTarget: HTMLElement }): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  const card = handle.closest<HTMLElement>(".message-attachment");
  const startX = event.clientX;
  const startWidth = card?.getBoundingClientRect().width ?? width();
  handle.setPointerCapture(event.pointerId);
  const direction = handle.dataset.side === "left" ? -1 : 1;
  const move = (next: PointerEvent) => setWidth(clamp(startWidth + direction * (next.clientX - startX)));
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, String(width()));
    } catch {
      // Private mode or a full store: the width lasts for this session only.
    }
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/** Double-click on the corner: back to the default width. */
export function resetVideoCardWidth(): void {
  setWidth(DEFAULT_WIDTH);
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept, nothing to remove.
  }
}
