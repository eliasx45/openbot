// Fork (docs/fork/FEATURES.md #73): while a splitter dragged, the cursor flickered between the resize
// cursor and the cursor of whatever the pointer crossed (a link's hand, a field's I-beam, the arrow of
// a window-drag strip). The drag now owns the cursor of the whole window until it ends.
import { createPointerDrag, holdDragCursor } from "@openbot/ui/components/createPointerDrag";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-pointer-drag");
  document.documentElement.style.removeProperty("--pointer-drag-cursor");
});

function handle(): HTMLElement {
  const element = document.createElement("hr");
  element.style.cursor = "col-resize";
  document.body.append(element);
  return element;
}

function pointer(type: string, clientX: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, button: 0, clientX, pointerId: 1 });
}

describe("a handle drag", () => {
  it("gives the window the handle's cursor until it ends", () => {
    const element = handle();
    const release = holdDragCursor(element);
    const root = document.documentElement;
    expect(root.hasAttribute("data-pointer-drag")).toBe(true);
    expect(root.style.getPropertyValue("--pointer-drag-cursor")).toBe("col-resize");
    expect(element.hasAttribute("data-pointer-drag-handle")).toBe(true);
    release();
    expect(root.hasAttribute("data-pointer-drag")).toBe(false);
    expect(root.style.getPropertyValue("--pointer-drag-cursor")).toBe("");
    expect(element.hasAttribute("data-pointer-drag-handle")).toBe(false);
  });

  it("holds the cursor from pointer down to pointer up, and through a cancel", () => {
    const element = handle();
    const moves: number[] = [];
    const drag = createPointerDrag({
      axis: "x",
      rootClass: "panel-resizing",
      onStart: () => {},
      onMove: (delta) => moves.push(delta),
    });
    const down = pointer("pointerdown", 10);
    Object.defineProperty(down, "currentTarget", { value: element });
    drag.begin(down);
    const root = document.documentElement;
    expect(root.hasAttribute("data-pointer-drag")).toBe(true);
    window.dispatchEvent(pointer("pointermove", 40));
    expect(moves).toEqual([30]);
    expect(root.hasAttribute("data-pointer-drag")).toBe(true);
    window.dispatchEvent(pointer("pointerup", 40));
    expect(root.hasAttribute("data-pointer-drag")).toBe(false);
    expect(root.classList.contains("panel-resizing")).toBe(false);

    const again = pointer("pointerdown", 10);
    Object.defineProperty(again, "currentTarget", { value: element });
    drag.begin(again);
    expect(root.hasAttribute("data-pointer-drag")).toBe(true);
    drag.cancel();
    expect(root.hasAttribute("data-pointer-drag")).toBe(false);
  });
});
