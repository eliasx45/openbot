// Fork (docs/fork/FEATURES.md #132): queue rows go straight to where they belong and do not blink,
// snap back or vanish while the host answers.
import type { QueueDelivery } from "@openbot/contracts/ipc";
import { QueuePanel } from "@openbot/ui/features/conversation/QueuePanel";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

function delivery(id: string, position: number | null, overrides: Partial<QueueDelivery> = {}): QueueDelivery {
  return {
    id,
    messageId: id,
    recipientAgentId: "vegapunk",
    sender: { kind: "user" },
    text: `Note ${id}`,
    attachments: [],
    replyToMessageId: null,
    status: "queued",
    position,
    turnId: null,
    error: null,
    createdAt: `2026-11-27T15:3${position ?? 9}:00.000Z`,
    ...overrides,
  };
}

const rowNames = () =>
  screen.getAllByRole("group").map((row) => row.getAttribute("aria-label")?.replace(/^Queued message \d*: /u, ""));

afterEach(() => {
  vi.useRealTimers();
});

describe("the queue panel", () => {
  it("lets the host's row take a sending row's place without a second row fading out", () => {
    const [deliveries, setDeliveries] = createSignal([delivery("pending:c1", null, { text: "Note d1" })]);
    const [handoffs, setHandoffs] = createSignal(new Map<string, string>());
    render(() => (
      <QueuePanel
        deliveries={deliveries()}
        sendingIds={new Set(deliveries().flatMap((item) => (item.id.startsWith("pending:") ? [item.id] : [])))}
        handoffs={handoffs()}
        canSteer
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onReorder={vi.fn()}
      />
    ));
    expect(screen.getByRole("button", { name: /Delete queued message/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Edit queued message/u })).toBeDisabled();

    setHandoffs(new Map([["d1", "pending:c1"]]));
    setDeliveries([delivery("d1", 1)]);
    flush();
    expect(screen.getAllByRole("group", { hidden: true })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delete queued message 1" })).toBeEnabled();
  });

  it("keeps a row the host starts in its slot, labelled Starting", () => {
    const [deliveries, setDeliveries] = createSignal([delivery("a", 1), delivery("b", 2), delivery("c", 3)]);
    render(() => (
      <QueuePanel
        deliveries={deliveries()}
        canSteer={false}
        onSteer={vi.fn()}
        onCancel={vi.fn()}
        onEdit={vi.fn()}
        onReorder={vi.fn()}
      />
    ));
    setDeliveries([delivery("a", null, { status: "starting" }), delivery("b", 1), delivery("c", 2)]);
    flush();
    expect(rowNames()).toEqual(["Note a", "Note b", "Note c"]);
    expect(screen.getAllByText("Starting")).toHaveLength(1);
  });

  it("shows a new order at once, before the host answers", () => {
    const deliveries = [delivery("a", 1), delivery("b", 2), delivery("c", 3)];
    const onReorder = vi.fn(() => new Promise<boolean>(() => {}));
    render(() => (
      <QueuePanel deliveries={deliveries} canSteer onCancel={vi.fn()} onEdit={vi.fn()} onReorder={onReorder} />
    ));
    const last = screen.getByRole("group", { name: /Note c$/u });
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowUp", altKey: true });
    flush();
    expect(onReorder).toHaveBeenLastCalledWith(["a", "c", "b"]);
    expect(rowNames()).toEqual(["Note a", "Note c", "Note b"]);
  });

  it("deletes one row on a fast double-click, not the row that slides under the pointer", () => {
    vi.useFakeTimers();
    const onCancel = vi.fn(() => Promise.resolve(true));
    render(() => (
      <QueuePanel
        deliveries={[delivery("a", 1), delivery("b", 2)]}
        canSteer
        onCancel={onCancel}
        onEdit={vi.fn()}
        onReorder={vi.fn()}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Delete queued message 1" }), { detail: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Delete queued message 2" }), { detail: 2 });
    vi.advanceTimersByTime(200);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("a");
  });

  it("brings a row back when the host refuses to delete it", async () => {
    vi.useFakeTimers();
    let refuse: (removed: boolean) => void = () => {};
    const onCancel = vi.fn(
      () =>
        new Promise<boolean>((settle) => {
          refuse = settle;
        }),
    );
    render(() => (
      <QueuePanel
        deliveries={[delivery("a", 1), delivery("b", 2)]}
        canSteer
        onCancel={onCancel}
        onEdit={vi.fn()}
        onReorder={vi.fn()}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Delete queued message 1" }));
    flush();
    expect(rowNames()).toEqual(["Note b"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(onCancel).toHaveBeenCalledWith("a");
    refuse(false);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(rowNames()).toEqual(["Note a", "Note b"]);
  });
});
