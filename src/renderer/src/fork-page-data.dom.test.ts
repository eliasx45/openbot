// Fork (docs/fork/FEATURES.md #123): openbotPage.data in the DOM: the page bootstrap's call, the ChatVisual host
// with its per-frame budget, and the refusals a page hears (main's checks: src/main/fork-page-data.test.ts).
import {
  CHAT_VISUAL_DATA_TOO_MANY,
  CHAT_VISUAL_DATA_UNAVAILABLE,
  CHAT_VISUAL_DATA_UNDECLARED,
} from "@openbot/contracts/chat-visual";
import type { PageDataOperation, PageStateReply } from "@openbot/contracts/fork-saved-apps";
import { ChatVisual } from "@openbot/ui/features/conversation/ChatVisual";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

interface PageData {
  query: (sql: string, params?: unknown) => Promise<unknown>;
  tables: () => Promise<string[]>;
}

interface PageWindow extends Window {
  eval: (code: string) => unknown;
  openbotPage?: { data: PageData };
}

function isPageWindow(value: Window | null): value is PageWindow {
  return value !== null && "eval" in value;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function showPage(onData?: (request: PageDataOperation) => Promise<PageStateReply>): Promise<PageData> {
  render(() => ChatVisual({ html: "<p>tasks</p>", title: "Tasks", onOpenLink: vi.fn(), onData }));
  const frame = screen.getByTitle<HTMLIFrameElement>("Tasks");
  await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("openbot-visual-bootstrap"));
  const page = frame.contentWindow;
  if (!isPageWindow(page)) throw new Error("The frame cannot run scripts.");
  const bootstrap = /<script id="openbot-visual-bootstrap">([\s\S]*?)<\/script>/u.exec(
    frame.getAttribute("srcdoc") ?? "",
  )?.[1];
  if (!bootstrap) throw new Error("The page has no bootstrap.");
  vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
    queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data, source: page })));
  });
  vi.spyOn(page, "postMessage").mockImplementation((data: unknown) => {
    queueMicrotask(() => page.dispatchEvent(new MessageEvent("message", { data, source: window })));
  });
  page.eval(
    "window.ResizeObserver=class{observe(){}};window.IntersectionObserver=class{observe(){}};window.requestAnimationFrame=(f)=>setTimeout(f);",
  );
  page.eval(bootstrap);
  const data = page.openbotPage?.data;
  if (!data) throw new Error("The page has no openbotPage.data.");
  return data;
}

describe("openbotPage.data", () => {
  it("sends the SQL and its parameters to the host and gives the page the rows", async () => {
    const requests: PageDataOperation[] = [];
    const data = await showPage(async (request) => {
      requests.push(request);
      return request.op === "tables"
        ? { ok: true, value: ["tasks"] }
        : { ok: true, value: { columns: ["title"], rows: [{ title: "Buy milk" }], truncated: false } };
    });
    expect(await data.query("SELECT title FROM tasks WHERE id > ?", [0])).toEqual({
      columns: ["title"],
      rows: [{ title: "Buy milk" }],
      truncated: false,
    });
    expect(await data.tables()).toEqual(["tasks"]);
    expect(requests).toEqual([
      { op: "query", sql: "SELECT title FROM tasks WHERE id > ?", params: [0] },
      { op: "tables" },
    ]);
    // A call the contract does not accept never reaches the host.
    await expect(data.query("SELECT ?", [{ nested: true }])).rejects.toThrow("Refused");
    expect(requests).toHaveLength(2);
  });

  it("gives the page main's refusal, and says data is not available where there is no host", async () => {
    const refusing = await showPage(async () => ({ ok: false, error: CHAT_VISUAL_DATA_UNDECLARED }));
    await expect(refusing.query("SELECT 1")).rejects.toThrow(CHAT_VISUAL_DATA_UNDECLARED);
    cleanup();
    const bare = await showPage();
    await expect(bare.query("SELECT 1")).rejects.toThrow(CHAT_VISUAL_DATA_UNAVAILABLE);
  });

  it("answers at most 10 calls in 10 seconds of one frame", async () => {
    const host = vi.fn(async (): Promise<PageStateReply> => ({ ok: true, value: [] }));
    const data = await showPage(host);
    const answers = await Promise.allSettled(Array.from({ length: 12 }, () => data.tables()));
    expect(answers.filter((answer) => answer.status === "fulfilled")).toHaveLength(10);
    expect(answers.at(-1)).toMatchObject({ status: "rejected", reason: new Error(CHAT_VISUAL_DATA_TOO_MANY) });
    expect(host).toHaveBeenCalledTimes(10);
  });
});
