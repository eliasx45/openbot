import { createSignal } from "solid-js";

interface PointerDragOptions {
  axis: "x" | "y";
  rootClass: string;
  onStart: () => void;
  onMove: (delta: number) => void;
  onEnd?: (delta: number) => void;
}

export const POINTER_DRAG_ATTRIBUTE = "data-pointer-drag";
export const POINTER_DRAG_CURSOR_VARIABLE = "--pointer-drag-cursor";

export function holdDragCursor(handle: HTMLElement): () => void {
  const root = document.documentElement;
  root.style.setProperty(POINTER_DRAG_CURSOR_VARIABLE, getComputedStyle(handle).cursor || "default");
  root.setAttribute(POINTER_DRAG_ATTRIBUTE, "");
  handle.setAttribute(`${POINTER_DRAG_ATTRIBUTE}-handle`, "");
  return () => {
    root.removeAttribute(POINTER_DRAG_ATTRIBUTE);
    root.style.removeProperty(POINTER_DRAG_CURSOR_VARIABLE);
    handle.removeAttribute(`${POINTER_DRAG_ATTRIBUTE}-handle`);
  };
}

export function createPointerDrag(options: PointerDragOptions) {
  let cleanup: (() => void) | undefined;
  const [isDragging, setIsDragging] = createSignal(false);

  const begin = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const position = (pointer: PointerEvent) => (options.axis === "x" ? pointer.clientX : pointer.clientY);
    const start = position(event);
    let delta = 0;
    options.onStart();
    setIsDragging(true);
    document.documentElement.classList.add(options.rootClass);
    const releaseCursor = holdDragCursor(handle);

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      delta = position(moveEvent) - start;
      options.onMove(delta);
    };
    const finish = (finishEvent?: PointerEvent) => {
      if (finishEvent && finishEvent.pointerId !== event.pointerId) return;
      if (finishEvent) delta = position(finishEvent) - start;
      options.onEnd?.(delta);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.documentElement.classList.remove(options.rootClass);
      releaseCursor();
      setIsDragging(false);
      cleanup = undefined;
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    const cancel = () => finish();

    cleanup?.();
    cleanup = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };

  return { begin, cancel: () => cleanup?.(), isDragging };
}
