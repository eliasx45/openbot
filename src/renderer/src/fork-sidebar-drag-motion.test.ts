// @vitest-environment node
// Fork (docs/fork/FEATURES.md #73): a chat dragged within its own folder tinted the whole folder with
// the blue drop box, and on drop the rows jumped back to the old order before they jumped to the new
// one. Now the box shows only when the drop moves the chat to another folder, and the rows slide.
import type { SidebarDragSource, SidebarDropTarget } from "@openbot/ui/features/sidebar/sidebar-drag-model";
import { chatDropSectionId } from "@openbot/ui/features/sidebar/sidebar-drag-model";
import { rowOrderChanged, rowSlideDeltas } from "@openbot/ui/features/sidebar/sidebar-row-motion";
import { describe, expect, it } from "vitest";

const sections: Record<string, string> = { vegapunk: "editing", robin: "editing", zita: "revisions" };
const sectionOf = (chatId: string) => sections[chatId] ?? "unassigned";
const vegapunk: SidebarDragSource = { kind: "chat", id: "vegapunk", origin: "section" };
const onRow = (chatId: string, sectionId: string): SidebarDropTarget => ({
  kind: "chat",
  target: { chatId, placement: "after", sectionId },
});

describe("the folder drop box during a chat drag", () => {
  it("does not show while the chat is reordered inside its own folder", () => {
    expect(chatDropSectionId(vegapunk, onRow("robin", "editing"), sectionOf)).toBeNull();
    expect(chatDropSectionId(vegapunk, { kind: "section", sectionId: "editing" }, sectionOf)).toBeNull();
  });

  it("shows on the other folder when the drop moves the chat there", () => {
    expect(chatDropSectionId(vegapunk, onRow("zita", "revisions"), sectionOf)).toBe("revisions");
    expect(chatDropSectionId(vegapunk, { kind: "section", sectionId: "revisions" }, sectionOf)).toBe("revisions");
  });

  it("shows for a pinned tile, which always leaves the pinned strip", () => {
    const pinned: SidebarDragSource = { kind: "pinned", id: "vegapunk", key: "agent:vegapunk", origin: "pinned" };
    expect(chatDropSectionId(pinned, onRow("robin", "editing"), sectionOf)).toBe("editing");
  });

  it("shows nothing without a chat target", () => {
    expect(chatDropSectionId(vegapunk, null, sectionOf)).toBeNull();
    expect(chatDropSectionId(vegapunk, { kind: "pinned", key: null }, sectionOf)).toBeNull();
  });
});

describe("the row slide after a change", () => {
  it("draws each row that moved back by the distance it moved", () => {
    const before = new Map([
      ["editors", 0],
      ["vegapunk", 52],
      ["robin", 104],
    ]);
    const after = new Map([
      ["editors", 0],
      ["robin", 52],
      ["vegapunk", 104],
      ["new", 156],
    ]);
    expect([...rowSlideDeltas(before, after)]).toEqual([
      ["robin", 52],
      ["vegapunk", -52],
    ]);
  });

  it("closes the gap of a removed row", () => {
    const before = new Map([
      ["a", 0],
      ["b", 52],
      ["c", 104],
    ]);
    const after = new Map([
      ["a", 0],
      ["c", 52],
    ]);
    expect([...rowSlideDeltas(before, after)]).toEqual([["c", 52]]);
  });

  it("waits for the new order before it settles a drop", () => {
    expect(rowOrderChanged(["a", "b", "c"], ["a", "b", "c"])).toBe(false);
    expect(rowOrderChanged(["a", "b", "c"], ["a", "c", "b"])).toBe(true);
    expect(rowOrderChanged(["a", "b"], ["a", "b", "c"])).toBe(true);
  });
});
