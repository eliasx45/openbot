import type { AgentMessage } from "@openbot/ui/data";
import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { beforeAll, describe, expect, it, vi } from "vitest";

function renderReply(body: string) {
  const message: AgentMessage = { id: "fenced-reply", author: "agent", body, time: "11:21", attachments: [] };
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

function typesetTex(element: Element): string[] {
  return Array.from(element.querySelectorAll("annotation"), (annotation) => annotation.textContent ?? "");
}

function codeBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".message-code-block"));
}

beforeAll(async () => {
  const { container } = render(() => (
    <MarkdownMessageText body="$x$" agents={[]} onSelectAgent={vi.fn()} onOpenLink={vi.fn()} />
  ));
  await waitFor(() => expect(typesetTex(container)).toEqual(["x"]));
  cleanup();
});

describe("a math fence in a reply", () => {
  const TEX = String.raw`\frac{a}{b} \\ c`;

  it("typesets the formula", () => {
    const { container } = renderReply(["Before", "", "```math", TEX, "```", "", "After"].join("\n"));
    expect(typesetTex(container)).toEqual([TEX]);
    expect(codeBlocks(container)).toHaveLength(0);
  });

  it("keeps the fence as code while it streams, then typesets it", () => {
    const body = ["Before", "", "```math", String.raw`\frac{a}{b}`].join("\n");
    const streaming = render(() => (
      <MarkdownMessageText body={body} streaming agents={[]} onSelectAgent={vi.fn()} onOpenLink={vi.fn()} />
    ));
    expect(typesetTex(streaming.container)).toEqual([]);
    expect(codeBlocks(streaming.container)).toHaveLength(1);
    cleanup();
    const done = render(() => (
      <MarkdownMessageText
        body={["```math", TEX, "```"].join("\n")}
        agents={[]}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
      />
    ));
    expect(typesetTex(done.container)).toEqual([TEX]);
  });
});
