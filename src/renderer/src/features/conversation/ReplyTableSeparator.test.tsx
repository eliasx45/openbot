import type { AgentMessage } from "@openbot/ui/data";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

function renderReply(body: string) {
  const message: AgentMessage = { id: "table-separator-reply", author: "agent", body, time: "11:21", attachments: [] };
  return render(() => (
    <MessageBody
      message={message}
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onPreview={vi.fn()}
      onAttachmentAction={vi.fn()}
    />
  ));
}

describe("a reply's table with a short delimiter row", () => {
  it.each([
    ["two hyphens", "|--|--|", "| --- | --- |"],
    ["one hyphen", "|-|-|", "| --- | --- |"],
    ["colons", "| :-- | --: |", "| --- | ---: |"],
    ["a centered column", "|:-:|---|", "| :---: | --- |"],
  ])("gets the table actions with %s", async (_name, delimiter, copiedDelimiter) => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderReply(["| Name | Size |", delimiter, "| small | 128k |"].join("\n"));
    fireEvent.click(screen.getByText("Copy as Markdown"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe(["| Name | Size |", copiedDelimiter, "| small | 128k |"].join("\n"));
  });
});
