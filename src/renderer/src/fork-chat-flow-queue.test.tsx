import type { QueueDelivery } from "@openbot/contracts/ipc";
import { QueuePanel } from "@openbot/ui/features/conversation/QueuePanel";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

function delivery(id: string, position: number): QueueDelivery {
  return {
    id,
    messageId: `message-${id}`,
    recipientAgentId: "chief",
    sender: { kind: "user" },
    text: `Note ${id}`,
    attachments: [],
    replyToMessageId: null,
    status: "queued",
    position,
    turnId: null,
    error: null,
    createdAt: `2026-11-24T10:0${position}:00.000Z`,
  };
}

const row = (id: string) => screen.getByRole("group", { name: new RegExp(`: Note ${id}$`, "u") });

describe("the queued message list", () => {
  it("keeps the moved message focused when the host sends the new order", () => {
    const [deliveries, setDeliveries] = createSignal([delivery("a", 1), delivery("b", 2), delivery("c", 3)]);
    const onReorder = vi.fn((ids: string[]) => setDeliveries(ids.map((id, index) => delivery(id, index + 1))));
    render(() => (
      <QueuePanel deliveries={deliveries()} canSteer onCancel={vi.fn()} onEdit={vi.fn()} onReorder={onReorder} />
    ));
    row("c").focus();
    fireEvent.keyDown(row("c"), { key: "ArrowUp", altKey: true });
    flush();
    expect(onReorder).toHaveBeenLastCalledWith(["a", "c", "b"]);
    expect(row("c")).toHaveAccessibleName("Queued message 2: Note c");
    expect(row("c")).toHaveFocus();

    fireEvent.keyDown(row("c"), { key: "ArrowUp", altKey: true });
    flush();
    expect(onReorder).toHaveBeenLastCalledWith(["c", "a", "b"]);
    expect(row("c")).toHaveAccessibleName("Queued message 1: Note c");
    expect(row("c")).toHaveFocus();
  });
});
