// Fork (docs/fork/FEATURES.md #123): openbotPage.state end to end in the DOM: the page bootstrap's JSON-RPC
// call, the ChatVisual host and a host that answers as main does (main's files: src/main/fork-saved-apps.test.ts),
// with a reload in between.
import {
  PAGE_STATE_VALUE_MAX,
  type PageStateOperation,
  type PageStateReply,
  type PageStateValue,
  parsePageStateRequest,
} from "@openbot/contracts/fork-saved-apps";
import { ChatVisual } from "@openbot/ui/features/conversation/ChatVisual";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

interface PageState {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  keys: () => Promise<string[]>;
}

interface PageWindow extends Window {
  eval: (code: string) => unknown;
  openbotPage?: { state: PageState };
}

function isPageWindow(value: Window | null): value is PageWindow {
  return value !== null && "eval" in value;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Answers as main's IPC handler does: the request through the contract parser, the 64 KB value limit. */
function savedApp() {
  const values = new Map<string, PageStateValue>();
  const requests: unknown[] = [];
  const host = async (operation: PageStateOperation): Promise<PageStateReply> => {
    const request = parsePageStateRequest({ ...operation, target: { appId: "app_AAAAAAAAAAAAAAAA" } });
    requests.push(request);
    if (request.op === "keys") return { ok: true, value: [...values.keys()] };
    if (request.op === "get") return { ok: true, value: values.get(request.key) ?? null };
    if (JSON.stringify(request.value).length > PAGE_STATE_VALUE_MAX)
      return { ok: false, error: "A saved value can be at most 64 KB." };
    if (request.value === null) values.delete(request.key);
    else values.set(request.key, request.value);
    return { ok: true, value: null };
  };
  return { host, requests };
}

/** Shows the page in ChatVisual, runs its bootstrap in the frame, and joins the two windows as a browser does. */
async function showPage(onState?: (request: PageStateOperation) => Promise<PageStateReply>): Promise<PageState> {
  render(() => ChatVisual({ html: "<p>count</p>", title: "Counter", onOpenLink: vi.fn(), onState }));
  const frame = screen.getByTitle<HTMLIFrameElement>("Counter");
  await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("openbot-visual-bootstrap"));
  const page = frame.contentWindow;
  if (!isPageWindow(page)) throw new Error("The frame cannot run scripts.");
  const bootstrap = /<script id="openbot-visual-bootstrap">([\s\S]*?)<\/script>/u.exec(
    frame.getAttribute("srcdoc") ?? "",
  )?.[1];
  if (!bootstrap) throw new Error("The page has no bootstrap.");
  // jsdom gives no message source and no observers: post as the browser does, with the sending window.
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
  const state = page.openbotPage?.state;
  if (!state) throw new Error("The page has no openbotPage.state.");
  return state;
}

describe("openbotPage.state", () => {
  it("saves, reads and lists values through the host, and keeps them across a reload", async () => {
    const { host, requests } = savedApp();
    const first = await showPage(host);

    expect(await first.get("count")).toBeNull();
    await first.set("count", 1);
    await first.set("count", 2);
    await first.set("todo", [{ text: "milk", done: false }]);
    expect(await first.get("count")).toBe(2);
    expect(await first.keys()).toEqual(["count", "todo"]);
    await first.set("todo", null);
    expect(await first.keys()).toEqual(["count"]);

    cleanup();
    const reloaded = await showPage(host);
    expect(await reloaded.get("count")).toBe(2);
    expect(requests).toContainEqual({
      op: "set",
      key: "todo",
      value: [{ text: "milk", done: false }],
      target: { appId: "app_AAAAAAAAAAAAAAAA" },
    });
  });

  it("answers the page an error over a limit, and keeps the earlier value", async () => {
    const { host } = savedApp();
    const state = await showPage(host);

    await state.set("note", "short");
    await expect(state.set("note", "x".repeat(70_000))).rejects.toThrow("A saved value can be at most 64 KB.");
    await expect(state.get("")).rejects.toThrow("Refused");
    await expect(state.set("bad", () => undefined)).resolves.toBeUndefined();
    expect(await state.get("note")).toBe("short");
    expect(await state.get("bad")).toBeNull();
  });

  it("tells the page saved data is not available where the host has none", async () => {
    const state = await showPage();
    await expect(state.get("count")).rejects.toThrow("Saved data is not available here.");
  });
});

describe("Save as app", () => {
  it("saves once while busy, then opens the saved app, and shows a failure line", async () => {
    let finish: (id: string) => void = () => undefined;
    const save = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const open = vi.fn();
    render(() =>
      ChatVisual({ html: "<p>count</p>", title: "Counter", onOpenLink: vi.fn(), saveAsApp: { save, open } }),
    );
    const button = screen.getByRole("button", { name: "Save as app", hidden: true });
    button.click();
    button.click();
    await waitFor(() => expect(button.textContent).toContain("Saving…"));
    expect(save).toHaveBeenCalledTimes(1);
    finish("app_AAAAAAAAAAAAAAAA");
    await waitFor(() => expect(button.textContent).toContain("Saved · Open"));
    button.click();
    button.click();
    expect(open).toHaveBeenCalledWith("app_AAAAAAAAAAAAAAAA");
    expect(save).toHaveBeenCalledTimes(1);

    cleanup();
    render(() =>
      ChatVisual({
        html: "<p>count</p>",
        title: "Counter",
        onOpenLink: vi.fn(),
        saveAsApp: { save: () => Promise.reject(new Error("This page could not be read.")), open },
      }),
    );
    screen.getByRole("button", { name: "Save as app", hidden: true }).click();
    expect(await screen.findByRole("alert", { hidden: true })).toHaveTextContent("This page could not be read.");
  });
});

describe("Save as app of a page already saved", () => {
  it("starts as Saved · Open and opens that app without saving again", () => {
    const save = vi.fn(async () => "app_BBBBBBBBBBBBBBBB");
    const open = vi.fn();
    render(() =>
      ChatVisual({
        html: "<p>count</p>",
        title: "Counter",
        onOpenLink: vi.fn(),
        saveAsApp: { save, open, savedAppId: () => "app_AAAAAAAAAAAAAAAA" },
      }),
    );
    const button = screen.getByRole("button", { name: "Saved · Open", hidden: true });
    button.click();
    expect(open).toHaveBeenCalledWith("app_AAAAAAAAAAAAAAAA");
    expect(save).not.toHaveBeenCalled();
  });
});
