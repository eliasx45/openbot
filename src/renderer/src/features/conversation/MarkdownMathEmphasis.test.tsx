import type { AgentMessage } from "@openbot/ui/data";
import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { beforeAll, describe, expect, it, vi } from "vitest";

function renderReply(body: string) {
  const message: AgentMessage = { id: "math-emphasis-reply", author: "agent", body, time: "11:21", attachments: [] };
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

function renderMarkdown(body: string) {
  return render(() => <MarkdownMessageText body={body} agents={[]} onSelectAgent={vi.fn()} onOpenLink={vi.fn()} />);
}

function renderTableCell(body: string) {
  return renderReply(["| Case | Value |", "|---|---|", `| one | ${body} |`].join("\n"));
}

function typesetTex(element: Element): string[] {
  return Array.from(element.querySelectorAll("annotation"), (annotation) => annotation.textContent ?? "");
}

function only(container: HTMLElement, selector: string): Element {
  const elements = container.querySelectorAll(selector);
  expect(elements).toHaveLength(1);
  const element = elements[0];
  if (!element) throw new Error(`no ${selector}`);
  return element;
}

beforeAll(async () => {
  const { container } = renderMarkdown("$x$");
  await waitFor(() => expect(typesetTex(container)).toEqual(["x"]));
  cleanup();
});

describe.each([
  ["a reply", renderReply],
  ["a Markdown text", renderMarkdown],
  ["a reply's table cell", renderTableCell],
])("emphasis around a formula with * or _ in %s", (_name, renderBody) => {
  it.each([
    ["*a $x*y$ b*", "em", "x*y", "a x*y b"],
    ["*Note: $a_*$ here*", "em", "a_*", "Note: a_* here"],
    ["**Let $x^{**}$ be** done", "strong", "x^{**}", "Let x^{**} be"],
    [
      String.raw`**Bold $\{x \mid x^* > 0\}$ set**`,
      "strong",
      String.raw`\{x \mid x^* > 0\}`,
      String.raw`Bold \{x \mid x^* > 0\} set`,
    ],
    [String.raw`*em \(x*y\) end*`, "em", "x*y", "em x*y end"],
    ["~~old $a~~b$ new~~", "del", "a~~b", "old a~~b new"],
  ])("%s keeps the formula whole inside <%s>", (body, tag, tex, text) => {
    const { container } = renderBody(body);
    const emphasis = only(container, tag);
    expect(typesetTex(emphasis)).toEqual([tex]);
    expect(emphasisText(emphasis)).toBe(text);
    expect(container.textContent).not.toContain("$");
  });

  it("keeps separate emphasis next to a formula with a star", () => {
    const { container } = renderBody("*a* $b*c$ *d*");
    expect(Array.from(container.querySelectorAll("em"), (em) => em.textContent)).toEqual(["a", "d"]);
    expect(typesetTex(container)).toEqual(["b*c"]);
  });

  it("keeps prices in emphasis as text", () => {
    const { container } = renderBody("*from $5 to $10*");
    expect(only(container, "em").textContent).toBe("from $5 to $10");
    expect(typesetTex(container)).toEqual([]);
  });
});

function emphasisText(element: Element): string {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) return "";
  for (const formula of copy.querySelectorAll(".katex")) {
    formula.replaceWith(formula.querySelector("annotation")?.textContent ?? "");
  }
  return copy.textContent ?? "";
}
