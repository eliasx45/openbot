// Fork (docs/fork/FEATURES.md #96, "Subfolders sit on a tree line"): inside an open folder its chats and
// folders are indented one step along a thin guide line, so a folder in a folder shows only its own
// name. Its tooltip, its label and its rename still use the folder's own record and full path. While a
// filter hides the parent's header, the folder is not indented under it and names the parent first.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import { Sidebar } from "@openbot/ui/features/sidebar/Sidebar";
import type { SidebarAgentState } from "@openbot/ui/features/sidebar/sidebar-types";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { STORY_AGENTS } from "./preview/fixtures";

const folder = {
  editing: "95959595-9595-4595-8595-959595959590",
  clients: "95959595-9595-4595-8595-959595959591",
  deep: "95959595-9595-4595-8595-959595959592",
  empty: "95959595-9595-4595-8595-959595959593",
};

const template = STORY_AGENTS[0];
if (!template) throw new Error("no story agent");
const agent = (id: string): AgentProfile => ({ ...template, id, name: `Agent ${id}`, threadId: `thread-${id}` });
const agents = ["robin", "zita", "deep"].map(agent);

/** Editing holds Clients (and the empty Later), Clients holds Deep: three levels. */
const layout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [
    { id: folder.editing, name: "Editing" },
    { id: folder.clients, name: "Clients", parentId: folder.editing },
    { id: folder.deep, name: "Deep", parentId: folder.clients },
    { id: folder.empty, name: "Later", parentId: folder.editing },
  ],
  order: ["people", folder.editing, folder.clients, folder.deep, folder.empty, "unassigned"],
  agentAssignments: { robin: folder.editing, zita: folder.clients, deep: folder.deep },
  agentOrder: ["robin", "zita", "deep"],
};

function show(states: Record<string, SidebarAgentState> = {}) {
  render(() => (
    <Sidebar
      serverName="Local"
      agents={agents}
      activeAgentId=""
      people={[]}
      directThreads={[]}
      activeDirectMemberId={null}
      agentStates={states}
      agentMoods={{}}
      layout={layout}
      collapsedSectionIds={[]}
      foldersSupported
      onMutateLayout={async () => undefined}
      onToggleSection={() => undefined}
      pinnedItems={[]}
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
      unreadAgentIds={new Set(Object.keys(states))}
      compact={false}
      onExpand={() => undefined}
      onOpenSearch={() => undefined}
      onOpenMarketplace={() => undefined}
    />
  ));
}

const section = (id: string) => {
  const element = document.querySelector<HTMLElement>(`.sidebar-folder[data-section-id="${id}"]`);
  if (!element) throw new Error(`no folder ${id}`);
  return element;
};
/** The header name of a folder: its text and its tooltip. */
const headerName = (id: string) => {
  const name = section(id).querySelector<HTMLElement>(":scope > header .sidebar-section-name");
  return name ? { text: name.textContent, title: name.title } : null;
};

describe("a folder in an open folder", () => {
  it("shows only its own name, with the full path in its tooltip and label", () => {
    show();
    expect(headerName(folder.editing)).toEqual({ text: "Editing", title: "Editing" });
    expect(headerName(folder.clients)).toEqual({ text: "Clients", title: "Editing / Clients" });
    expect(headerName(folder.deep)).toEqual({ text: "Deep", title: "Editing / Clients / Deep" });
    expect(headerName(folder.empty)).toEqual({ text: "Later", title: "Editing / Later" });
    expect(section(folder.deep).getAttribute("aria-label")).toBe("Editing / Clients / Deep");
    // No header names a parent.
    expect(screen.queryByRole("button", { name: /\// })).toBeNull();
    // Each level is a folder in its parent's body, so the indent and the line repeat per level.
    expect(section(folder.deep).dataset.depth).toBe("2");
    const clients = screen.getByRole("region", { name: "Editing / Clients" });
    expect(within(clients).getByRole("region", { name: "Editing / Clients / Deep" })).toBe(section(folder.deep));
    for (const id of Object.values(folder)) expect(section(id).hasAttribute("data-headless")).toBe(false);
  });

  it("renames with its own name, not the path", async () => {
    show();
    const clients = section(folder.clients).querySelector<HTMLElement>(":scope > header button");
    if (!clients) throw new Error("no Clients header");
    fireEvent.contextMenu(clients, { clientX: 40, clientY: 40 });
    const menu = await screen.findByRole("menu", { name: "Folder actions" });
    fireEvent.pointerUp(within(menu).getByRole("menuitem", { name: "Rename" }), { button: 0, pointerType: "mouse" });
    const input = await waitFor(() => {
      const field = section(folder.clients).querySelector<HTMLInputElement>(".sidebar-section-editor");
      if (!field) throw new Error("no editor yet");
      return field;
    });
    expect(input.value).toBe("Clients");
  });

  it("names its parent first and is not indented under it while a filter hides the parent's header", async () => {
    // Only Deep has unread replies, so the Unread filter shows Editing and Clients only for Deep.
    show({ deep: { kind: "unread", count: 2 } });
    const button = screen.getByRole("button", { name: "Filter chats" });
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    const menu = await screen.findByRole("menu", { name: "Filter chats" });
    fireEvent.pointerUp(within(menu).getByRole("menuitemcheckbox", { name: /Unread/ }), {
      button: 0,
      pointerType: "mouse",
    });
    await waitFor(() => expect(section(folder.clients).hasAttribute("data-headless")).toBe(true));
    expect(section(folder.editing).hasAttribute("data-headless")).toBe(true);
    expect(section(folder.deep).hasAttribute("data-headless")).toBe(false);
    expect(headerName(folder.editing)).toBeNull();
    expect(headerName(folder.deep)?.text).toBe("Clients / Deep");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Filter chats" })).toBeNull());
    // The accessible name trims the space at the end of the muted parent span: "Clients /Deep".
    expect(screen.getByRole("button", { name: /^Clients \/\s*Deep$/ })).toBeTruthy();
  });
});

describe("the tree line styles", () => {
  const css = readFileSync(resolve(__dirname, "styles/fork-sidebar.css"), "utf8");
  const rules = [...css.matchAll(/(^|\n)([^{}\n@/][^{}]*)\{([^}]*)\}/g)].map((match) => ({
    selector: (match[2] ?? "").replace(/\s+/g, " ").trim(),
    body: match[3] ?? "",
  }));
  const body = rules.find((rule) => rule.selector.endsWith("> .sidebar-section-body"));
  const line = rules.find((rule) => rule.selector.endsWith("> .sidebar-section-body::before"));

  it("indents an open folder's body one step, not in the compact rail or under a hidden header", () => {
    expect(body?.selector).toContain(".sidebar:not(.sidebar-compact)");
    expect(body?.selector).toContain(".sidebar-folder:not([data-headless])");
    expect(body?.body).toMatch(/padding-inline-start:\s*var\(--sidebar-tree-indent\)/);
    expect(css).toMatch(/--sidebar-tree-indent:\s*var\(--openbot-space-4\)/);
  });

  it("draws a 1px guide line in the middle of the step, under the rows' pointer events", () => {
    expect(line?.selector).toContain(".sidebar-folder:not([data-headless])");
    expect(line?.body).toMatch(/width:\s*1px/);
    expect(line?.body).toMatch(/inset-inline-start:\s*calc\(var\(--sidebar-tree-indent\) \/ 2 - 1px\)/);
    expect(line?.body).toMatch(/pointer-events:\s*none/);
  });

  it("closes the drop outline of a closed or empty folder on its header", () => {
    const outline = rules.find((rule) => rule.selector.includes("sidebar-section-body:empty"));
    expect(outline?.selector).toContain(".sidebar-section-collapse[data-collapsed]");
    expect(outline?.selector).toMatch(/> header::before$/);
    expect(outline?.body).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--sidebar-drop-outline\)/);
  });
});
