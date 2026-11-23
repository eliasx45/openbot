// Fork (docs/fork/FEATURES.md #94): checks that a dragged folder or chat lands where the sidebar showed
// it would go, and that the place persists. The drop actions that `stores/layout-actions.ts` sends run
// against the real sidebar layout store on a temporary profile, through the same backend path as the
// `agent:mutate-sidebar-layout` handler: a folder reordered at the top of the list, a folder put above,
// between and below the chats of its parent folder, a chat put between two folders, a chat that leaves
// the folder, and each place again after the store reads its file from disk. The shown order comes from
// `sidebarFolderItems`, the function that the sidebar renders with.
// Run: `bun scripts/sidebar-folder-reorder-e2e.ts`.
// Writes .openbot-build/sidebar-folder-reorder-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarFolderItem,
  type SidebarLayoutAction,
  type SidebarLayoutSnapshot,
  sidebarFolderItems,
  sidebarFolderParents,
  sidebarPlaceFallback,
} from "@openbot/contracts/ipc";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build/sidebar-folder-reorder-e2e");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; unverified: string[]; steps: Step[] } = {
  passed: false,
  unverified: [
    "The pointer, the drop preview and the row motion. This check sends the drop actions to the backend; the drags themselves were checked by hand on a dev instance.",
    "The drop action is built here as `placeAction` in `stores/layout-actions.ts` builds it, which `typecheck:node` cannot follow into its .tsx imports.",
  ],
  steps: [],
};

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const root = await mkdtemp(join(tmpdir(), "openbot-sidebar-folder-reorder-"));
const file = join(root, "sidebar-layout.json");
let store = new SidebarLayoutStore(file);
await runCauseEffect(store.initialize());

const chats = new Map([
  ["agent-editors", "Editors"],
  ["agent-botbot", "Bot Bot"],
  ["agent-owl", "Owl"],
]);
const chatIds = new Set(chats.keys());
const mutate = (action: SidebarLayoutAction) => runCauseEffect(store.mutate(action, chatIds));
const sectionIdOf = (layout: SidebarLayoutSnapshot, name: string) => {
  const id = layout.sections.find((section) => section.name === name)?.id;
  assert.ok(id, `No folder ${name}.`);
  return id;
};
const nameOf = (layout: SidebarLayoutSnapshot, item: SidebarFolderItem) =>
  item.kind === "chat" ? (chats.get(item.id) ?? item.id) : `[${layout.sections.find((s) => s.id === item.id)?.name}]`;

/** The rows of a folder as the sidebar shows them: chats by `agentOrder`, folders by their place. */
function shown(layout: SidebarLayoutSnapshot, folderName: string): string[] {
  const folderId = sectionIdOf(layout, folderName);
  const parents = sidebarFolderParents(layout);
  const rank = new Map(layout.agentOrder.map((chatId, index) => [chatId, index]));
  const folderChats = [...chatIds]
    .filter((chatId) => layout.agentAssignments[chatId] === folderId)
    .sort((left, right) => (rank.get(left) ?? 1e9) - (rank.get(right) ?? 1e9));
  const folders = layout.order.filter((sectionId) => parents.get(sectionId) === folderId);
  const anchors = new Map(layout.sections.map((section) => [section.id, section.beforeChatId]));
  return sidebarFolderItems(folderChats, folders, (id) => anchors.get(id)).map((item) => nameOf(layout, item));
}

/** The action the sidebar sends for a drop of `item` before or after `beside` in a folder. */
function placeAction(
  layout: SidebarLayoutSnapshot,
  folderName: string,
  item: SidebarFolderItem,
  beside: SidebarFolderItem,
  placement: "before" | "after",
): Extract<SidebarLayoutAction, { type: "place" }> {
  const folderId = sectionIdOf(layout, folderName);
  const parents = sidebarFolderParents(layout);
  const rank = new Map(layout.agentOrder.map((chatId, index) => [chatId, index]));
  const anchors = new Map(layout.sections.map((section) => [section.id, section.beforeChatId]));
  const items = sidebarFolderItems(
    [...chatIds]
      .filter((chatId) => layout.agentAssignments[chatId] === folderId)
      .sort((left, right) => (rank.get(left) ?? 1e9) - (rank.get(right) ?? 1e9)),
    layout.order.filter((sectionId) => parents.get(sectionId) === folderId),
    (id) => anchors.get(id),
  ).filter((candidate) => candidate.kind !== item.kind || candidate.id !== item.id);
  const index = items.findIndex((candidate) => candidate.kind === beside.kind && candidate.id === beside.id);
  assert.ok(index >= 0);
  const after = items.slice(index + (placement === "after" ? 1 : 0));
  return {
    type: "place",
    item,
    parentId: folderId,
    beforeAgentId: after.find((candidate) => candidate.kind === "chat")?.id ?? null,
    beforeSectionId: after.find((candidate) => candidate.kind === "section")?.id ?? null,
  };
}

async function reload(): Promise<SidebarLayoutSnapshot> {
  store = new SidebarLayoutStore(file);
  await runCauseEffect(store.initialize());
  return store.getSnapshot();
}

const folder = (layout: SidebarLayoutSnapshot, name: string): SidebarFolderItem => ({
  kind: "section",
  id: sectionIdOf(layout, name),
});
const chat = (id: string): SidebarFolderItem => ({ kind: "chat", id });

try {
  await step(
    "setup: top folders Editing, Engineering, School; Editing holds Editors, Bot Bot and Clients",
    async () => {
      for (const name of ["Editing", "Engineering", "School"]) await mutate({ type: "create", name });
      let layout = store.getSnapshot();
      await mutate({ type: "create", name: "Clients", parentId: sectionIdOf(layout, "Editing") });
      await mutate({ type: "create", name: "Archive", parentId: sectionIdOf(layout, "Editing") });
      for (const chatId of ["agent-editors", "agent-botbot"])
        await mutate({
          type: "move-agent",
          agentId: chatId,
          sectionId: sectionIdOf(layout, "Editing"),
          beforeAgentId: null,
        });
      await mutate({
        type: "move-agent",
        agentId: "agent-owl",
        sectionId: sectionIdOf(layout, "School"),
        beforeAgentId: null,
      });
      layout = store.getSnapshot();
      assert.deepEqual(shown(layout, "Editing"), ["Editors", "Bot Bot", "[Clients]", "[Archive]"]);
      return shown(layout, "Editing");
    },
  );

  const top = (layout: SidebarLayoutSnapshot) =>
    layout.order
      .filter((id) => !sidebarFolderParents(layout).has(id))
      .map((id) =>
        id === SIDEBAR_PEOPLE_SECTION_ID || id === SIDEBAR_UNASSIGNED_SECTION_ID
          ? id
          : (layout.sections.find((section) => section.id === id)?.name ?? id),
      );

  await step("top level: School dropped above Editing, then at the bottom, persists", async () => {
    let layout = store.getSnapshot();
    await mutate({
      type: "nest",
      sectionId: sectionIdOf(layout, "School"),
      parentId: null,
      beforeSectionId: sectionIdOf(layout, "Editing"),
    });
    layout = store.getSnapshot();
    const expected = top(layout).filter((name) => name !== "School");
    expected.splice(expected.indexOf("Editing"), 0, "School");
    assert.deepEqual(top(layout), expected);
    await mutate({ type: "nest", sectionId: sectionIdOf(layout, "School"), parentId: null, beforeSectionId: null });
    layout = store.getSnapshot();
    assert.equal(top(layout).at(-1), "School");
    assert.deepEqual(top(await reload()), top(layout));
    return top(layout);
  });

  await step("drop back in place changes nothing and keeps the revision", async () => {
    const layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", folder(layout, "Clients"), chat("agent-botbot"), "after"));
    assert.equal(store.getSnapshot().revision, layout.revision);
    return shown(store.getSnapshot(), "Editing");
  });

  await step("the subfolder dropped above the chats of its folder stays there (the recording)", async () => {
    const layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", folder(layout, "Clients"), chat("agent-editors"), "before"));
    assert.deepEqual(shown(store.getSnapshot(), "Editing"), ["[Clients]", "Editors", "Bot Bot", "[Archive]"]);
    assert.deepEqual(shown(await reload(), "Editing"), ["[Clients]", "Editors", "Bot Bot", "[Archive]"]);
    return shown(store.getSnapshot(), "Editing");
  });

  await step("the subfolder dropped between two chats", async () => {
    const layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", folder(layout, "Clients"), chat("agent-editors"), "after"));
    assert.deepEqual(shown(store.getSnapshot(), "Editing"), ["Editors", "[Clients]", "Bot Bot", "[Archive]"]);
    return shown(store.getSnapshot(), "Editing");
  });

  await step("a chat dropped above a subfolder, and between two subfolders", async () => {
    let layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", chat("agent-botbot"), folder(layout, "Clients"), "before"));
    assert.deepEqual(shown(store.getSnapshot(), "Editing"), ["Editors", "Bot Bot", "[Clients]", "[Archive]"]);
    layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", chat("agent-botbot"), folder(layout, "Archive"), "before"));
    assert.deepEqual(shown(store.getSnapshot(), "Editing"), ["Editors", "[Clients]", "Bot Bot", "[Archive]"]);
    return shown(store.getSnapshot(), "Editing");
  });

  await step("a chat from another folder dropped at the very top and the very bottom", async () => {
    let layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", chat("agent-owl"), chat("agent-editors"), "before"));
    assert.deepEqual(shown(store.getSnapshot(), "Editing"), ["Owl", "Editors", "[Clients]", "Bot Bot", "[Archive]"]);
    layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", chat("agent-owl"), folder(layout, "Archive"), "after"));
    assert.deepEqual(shown(store.getSnapshot(), "Editing"), ["Editors", "[Clients]", "Bot Bot", "[Archive]", "Owl"]);
    return shown(store.getSnapshot(), "Editing");
  });

  await step("a chat that leaves the folder keeps the subfolders where they show", async () => {
    let layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", folder(layout, "Clients"), chat("agent-botbot"), "after"));
    layout = store.getSnapshot();
    assert.deepEqual(shown(layout, "Editing"), ["Editors", "Bot Bot", "[Clients]", "[Archive]", "Owl"]);
    await mutate({
      type: "move-agent",
      agentId: "agent-owl",
      sectionId: sectionIdOf(layout, "School"),
      beforeAgentId: null,
    });
    await mutate({
      type: "move-agent",
      agentId: "agent-botbot",
      sectionId: sectionIdOf(layout, "School"),
      beforeAgentId: null,
    });
    assert.deepEqual(shown(store.getSnapshot(), "Editing"), ["Editors", "[Clients]", "[Archive]"]);
    return shown(store.getSnapshot(), "Editing");
  });

  await step("a subfolder moved to another folder drops its place, and the file keeps every place", async () => {
    let layout = store.getSnapshot();
    await mutate(placeAction(layout, "Editing", folder(layout, "Archive"), chat("agent-editors"), "before"));
    layout = store.getSnapshot();
    assert.deepEqual(shown(layout, "Editing"), ["[Archive]", "Editors", "[Clients]"]);
    await mutate({
      type: "nest",
      sectionId: sectionIdOf(layout, "Clients"),
      parentId: sectionIdOf(layout, "School"),
      beforeSectionId: null,
    });
    layout = store.getSnapshot();
    assert.equal(layout.sections.find((section) => section.name === "Clients")?.beforeChatId, undefined);
    assert.deepEqual(shown(layout, "School"), ["Owl", "Bot Bot", "[Clients]"]);
    const reloaded = await reload();
    assert.deepEqual(shown(reloaded, "Editing"), ["[Archive]", "Editors"]);
    // The file itself names the chat the folder shows before.
    assert.match(await readFile(file, "utf8"), /"name":"Archive","parentId":"[^"]+","beforeChatId":"agent-editors"/);
    return { Editing: shown(reloaded, "Editing"), School: shown(reloaded, "School") };
  });

  await step("a host without `place` gets move-agent or nest with the same neighbours", async () => {
    const layout = store.getSnapshot();
    const action = placeAction(layout, "School", chat("agent-owl"), folder(layout, "Clients"), "after");
    assert.deepEqual(sidebarPlaceFallback(action), {
      type: "move-agent",
      agentId: "agent-owl",
      sectionId: sectionIdOf(layout, "School"),
      beforeAgentId: null,
    });
    return sidebarPlaceFallback(action);
  });

  report.passed = true;
} finally {
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
