import mermaid from "mermaid";
import { beforeAll, describe, expect, it } from "vitest";
import { quoteFlowchartLabels } from "../../../packages/ui/src/features/conversation/mermaid-label-repair";

// Fork #122: a flowchart label with an email address (`MAIL[hello@site.com]`) broke the whole
// diagram ("Cannot draw the diagram"). The chat now retries with the labels quoted.

const parses = async (source: string) => {
  try {
    await mermaid.parse(source);
    return true;
  } catch {
    return false;
  }
};

const FRANKY = `flowchart LR
  GH[GitHub main] -->|auto-deploy| CF[Cloudflare Pages]
  NC[Namecheap domain] -->|nameservers| DNS[Cloudflare DNS]
  DNS --> CF
  DNS --> MAIL[hello@immunity-media.com → your Gmail]`;

describe("quoteFlowchartLabels", () => {
  beforeAll(() => mermaid.initialize({ startOnLoad: false }));

  it("repairs the diagram that failed in the Agency chat", async () => {
    expect(await parses(FRANKY)).toBe(false);
    const repaired = quoteFlowchartLabels(FRANKY);
    expect(repaired).toContain('MAIL["hello@immunity-media.com → your Gmail"]');
    expect(repaired).toContain('-->|"auto-deploy"|');
    expect(await parses(repaired ?? "")).toBe(true);
  });

  it("repairs an email in an arrow label", async () => {
    const source = "graph TD\n  A -->|mail@x.com| B";
    expect(await parses(source)).toBe(false);
    expect(await parses(quoteFlowchartLabels(source) ?? "")).toBe(true);
  });

  it.each([
    ["box", "A[a@b.com]", 'A["a@b.com"]'],
    ["round", "A(a@b.com)", 'A("a@b.com")'],
    ["diamond", "A{a@b.com}", 'A{"a@b.com"}'],
    ["circle", "A((a@b.com))", 'A(("a@b.com"))'],
    ["stadium", "A([a@b.com])", 'A(["a@b.com"])'],
    ["subroutine", "A[[a@b.com]]", 'A[["a@b.com"]]'],
    ["cylinder", "A[(a@b.com)]", 'A[("a@b.com")]'],
    ["hexagon", "A{{a@b.com}}", 'A{{"a@b.com"}}'],
  ])("quotes a %s label", async (_name, node, quoted) => {
    const source = `flowchart LR\n  ${node} --> B[done]`;
    const repaired = quoteFlowchartLabels(source);
    expect(repaired).toContain(quoted);
    expect(await parses(repaired ?? "")).toBe(true);
  });

  it("leaves quoted labels, plain arrows and text inside quotes alone", async () => {
    const source = 'flowchart LR\n  A["fn(x) a@b"] --> B\n  B -.-> C\n  C ==> D["x"]';
    expect(quoteFlowchartLabels(source)).toBeUndefined();
  });

  it("keeps subgraphs, styles and classes working", async () => {
    const source = [
      "%% comment",
      "flowchart TB",
      "  subgraph web[Web @ edge]",
      "    A[a@b.com]:::hot --> B",
      "  end",
      "  classDef hot fill:#f96",
      "  style B fill:#bbf",
    ].join("\n");
    expect(await parses(source)).toBe(false);
    expect(await parses(quoteFlowchartLabels(source) ?? "")).toBe(true);
  });

  it("does not touch other diagram types", () => {
    expect(quoteFlowchartLabels("sequenceDiagram\n  A->>B: mail a@b.com")).toBeUndefined();
    expect(quoteFlowchartLabels('pie\n  "a" : 1')).toBeUndefined();
  });

  it("finds the header after front matter", () => {
    const source = "---\ntitle: x\n---\nflowchart LR\n  A[a@b] --> B";
    expect(quoteFlowchartLabels(source)).toContain('A["a@b"]');
  });
});
