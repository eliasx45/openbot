import type { AgentMessage } from "@openbot/ui/data";
import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library";
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

async function copiedCode(block: HTMLElement): Promise<string> {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(within(block).getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  return writeText.mock.calls[0]?.[0] ?? "";
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

describe("a tilde fence in a reply", () => {
  it("keeps a table inside the fence as code", async () => {
    const table = ["| a | b |", "|---|---|", "| 1 | 2 |"];
    const { container } = renderReply(["Data:", "", "~~~", ...table, "~~~"].join("\n"));
    expect(container.querySelector("table")).toBeNull();
    const [block, ...others] = codeBlocks(container);
    expect(others).toHaveLength(0);
    if (!block) throw new Error("no code block");
    expect(await copiedCode(block)).toBe(table.join("\n"));
  });

  it("keeps a backtick fence inside a tilde fence as code", async () => {
    const inner = ["```js", "const a = 1;", "```"];
    const { container } = renderReply(["~~~markdown", ...inner, "~~~", "", "Done."].join("\n"));
    const [block, ...others] = codeBlocks(container);
    expect(others).toHaveLength(0);
    if (!block) throw new Error("no code block");
    expect(await copiedCode(block)).toBe(inner.join("\n"));
    expect(container.textContent).toContain("Done.");
  });
});

describe("a fence inside a list item in a reply", () => {
  it.each([
    ["an ordered item", ["1. Install:", "   ```bash", "   npm i", "     --flag", "   ```", "2. Run it."]],
    ["a bullet item", ["- Code:", "  ```py", "  def f():", "      return 1", "  ```", "- Done."]],
  ])("copies the code without the indent of %s", async (_name, lines) => {
    const { container } = renderReply(lines.join("\n"));
    const [block] = codeBlocks(container);
    if (!block) throw new Error("no code block");
    const fence = lines.findIndex((line) => line.trimStart().startsWith("```"));
    const indent = lines[fence]?.indexOf("`") ?? 0;
    const code = lines.slice(fence + 1, fence + 3).map((line) => line.slice(indent));
    expect(await copiedCode(block)).toBe(code.join("\n"));
  });
});
