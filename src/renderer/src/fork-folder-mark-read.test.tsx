// Fork (docs/fork/FEATURES.md #91, "Mark read on a folder"): a folder's menu marks each unread agent in
// the folder and in the folders in it read, through the agent menu's Mark read, and then shows no badge.
import type { SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import { Sidebar } from "@openbot/ui/features/sidebar/Sidebar";
import type { SidebarAgentState } from "@openbot/ui/features/sidebar/sidebar-types";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { STORY_AGENTS } from "./preview/fixtures";

const folder = {
  editing: "91919191-9191-4191-8191-919191919190",
  clips: "91919191-9191-4191-8191-919191919191",
  deep: "91919191-9191-4191-8191-919191919192",
  other: "91919191-9191-4191-8191-919191919193",
};

const template = STORY_AGENTS[0];
if (!template) throw new Error("no story agent");
const agent = (id: string): AgentProfile => ({ ...template, id, name: `Agent ${id}`, threadId: `thread-${id}` });
const agents = ["robin", "zita", "deep", "quiet", "outside", "pinned"].map(agent);

/** Editing holds Clips, which holds Deep: three levels. */
const layout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [
    { id: folder.editing, name: "Editing" },
    { id: folder.clips, name: "Clips", parentId: folder.editing },
    { id: folder.deep, name: "Deep", parentId: folder.clips },
    { id: folder.other, name: "Other" },
  ],
  order: ["people", folder.editing, folder.clips, folder.deep, folder.other, "unassigned"],
  agentAssignments: {
    robin: folder.editing,
    quiet: folder.editing,
    pinned: folder.editing,
    zita: folder.clips,
    deep: folder.deep,
    outside: folder.other,
  },
  agentOrder: ["robin", "quiet", "pinned", "zita", "deep", "outside"],
};

function show() {
  // Robin has 19 unread replies, Deep 2. Zita's only unread replies are in a side thread, so she has
  // no number but is unread. The pinned agent shows in the pinned strip, not in the folder.
  const [states, setStates] = createSignal<Record<string, SidebarAgentState>>({
    robin: { kind: "unread", count: 19 },
    deep: { kind: "unread", count: 2 },
    outside: { kind: "unread", count: 4 },
    pinned: { kind: "unread", count: 1 },
  });
  const [unread, setUnread] = createSignal<ReadonlySet<string>>(
    new Set(["robin", "zita", "deep", "outside", "pinned"]),
  );
  const markRead = vi.fn((agentId: string) => {
    setUnread((current) => new Set([...current].filter((id) => id !== agentId)));
    setStates((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== agentId)));
  });
  const toggle = vi.fn();
  render(() => (
    <Sidebar
      serverName="Local"
      agents={agents}
      activeAgentId=""
      people={[]}
      directThreads={[]}
      activeDirectMemberId={null}
      agentStates={states()}
      agentMoods={{}}
      layout={layout}
      collapsedSectionIds={[folder.editing]}
      foldersSupported
      onMutateLayout={async () => undefined}
      onToggleSection={toggle}
      pinnedItems={[{ kind: "agent", id: "pinned" }]}
      peopleOrder={[]}
      onPin={() => undefined}
      onUnpin={() => undefined}
      onReorderPinned={() => undefined}
      onReorderPeople={() => undefined}
      onSelectAgent={() => undefined}
      onSelectPerson={() => undefined}
      onCreateAgent={() => undefined}
      onEditAgent={() => undefined}
      onDeleteAgent={async () => undefined}
      unreadAgentIds={unread()}
      onMarkAgentRead={markRead}
      compact={false}
      onExpand={() => undefined}
      onOpenSearch={() => undefined}
      onOpenMarketplace={() => undefined}
    />
  ));
  return { markRead, toggle };
}

const header = (name: string) => {
  const button = screen.getAllByRole("button").find((element) => element.textContent?.startsWith(name));
  if (!button) throw new Error(`no header ${name}`);
  return button;
};

/** The unread badge of a closed folder, or null. */
const badge = (name: string) => header(name).querySelector(".sidebar-folder-unread")?.textContent ?? null;

async function openMenu(name: string) {
  fireEvent.contextMenu(header(name), { clientX: 40, clientY: 40 });
  return screen.findByRole("menu", { name: "Folder actions" });
}

it("marks every unread agent of a folder and its folders read, once, and clears its badge", async () => {
  const { markRead, toggle } = show();
  // The closed folder counts Robin's 19 and Deep's 2.
  expect(badge("Editing")).toBe("21");

  const menu = await openMenu("Editing");
  const items = within(menu).getAllByRole("menuitem");
  // Mark read comes first, before Rename.
  expect(items[0]?.textContent).toBe("Mark read");
  expect(items[1]?.textContent).toBe("Rename");

  const item = within(menu).getByRole("menuitem", { name: "Mark read" });
  // A mouse click selects on release. A fast second click must not mark again.
  fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
  // The second click of a fast double click can land on what was under the menu: it opens nothing.
  fireEvent.click(header("Other"));
  expect(toggle).not.toHaveBeenCalled();
  // It renames nothing either: Rename does not move up under the pointer.
  expect(screen.queryByRole("textbox")).toBeNull();

  // The agents in Editing, Clips and Deep: not the read one, the pinned one or the one in Other.
  expect(markRead.mock.calls.map(([agentId]) => agentId)).toEqual(["robin", "zita", "deep"]);
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Folder actions" })).toBeNull());
  expect(badge("Editing")).toBeNull();

  // Nothing is unread in it now, so its menu has no Mark read.
  const again = await openMenu("Editing");
  expect(within(again).queryByRole("menuitem", { name: "Mark read" })).toBeNull();
});

it("shows Mark read on a folder only while an agent in it is unread", async () => {
  show();
  const other = await openMenu("Other");
  expect(within(other).getByRole("menuitem", { name: "Mark read" })).toBeTruthy();
});
