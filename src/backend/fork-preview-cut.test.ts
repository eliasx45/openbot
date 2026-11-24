import { markdownPreviewSource, markdownPreviewText, textPrefix } from "@openbot/contracts/markdown-preview-text";
import { describe, expect, it } from "vitest";
import { compactRuntimeQuestion } from "./agent/runtime-snapshot";

const LIMIT = 180;
const LEAD = "I checked the three deploys and the logs of every service in each region. ";
const MATRIX = String.raw`\begin{pmatrix}1&-2&-1\\-1&1&0\\-1&0&-1\end{pmatrix}`;

function sidebarLine(reply: string): string {
  return markdownPreviewText(markdownPreviewSource(reply, LIMIT));
}

function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}

describe("the preview source of a long reply", () => {
  it("keeps a short reply as written", () => {
    expect(markdownPreviewSource("**Done.** See `x`.", LIMIT)).toBe("**Done.** See `x`.");
  });

  it("does not stop inside bold text", () => {
    const reply = `${LEAD}${LEAD}**The root cause is that the cache layer drops writes when the TTL is zero.** Fixed.`;
    const line = sidebarLine(reply);
    expect(line).not.toContain("**");
    expect(line.startsWith(LEAD.trim())).toBe(true);
  });

  it("does not stop inside display math", () => {
    const reply = `Here is the matrix you asked for:\n\n$$\n${MATRIX}\\cdot${MATRIX}\\cdot${MATRIX}\n$$\n\nDone.`;
    const line = sidebarLine(reply);
    expect(line).not.toContain("$");
    expect(line.startsWith("Here is the matrix you asked for:")).toBe(true);
  });

  it("does not stop inside a link", () => {
    const reply = `See [the design doc](https://example.com/${"very-long-path/".repeat(14)}design) for the details and the plan.`;
    const line = sidebarLine(reply);
    expect(line).not.toMatch(/[[\]()]/u);
    expect(line.startsWith("See the design doc")).toBe(true);
  });

  it("does not stop inside a code span", () => {
    const reply = `${LEAD}${LEAD}Run \`bun run test:related -- src/backend/agent-store.ts --maxWorkers=1\` next.`;
    expect(sidebarLine(reply)).not.toContain("`");
  });

  it("does not cut an emoji in half", () => {
    const reply = `${"a".repeat(LIMIT - 1)}👋🏽 and more`;
    const source = markdownPreviewSource(reply, LIMIT);
    expect(hasLoneSurrogate(source)).toBe(false);
    expect(source.length).toBeLessThanOrEqual(LIMIT);
  });

  it("never gives more than the limit", () => {
    const replies = [
      `${LEAD.repeat(4)}`,
      `**${LEAD.repeat(4).trim()}**`,
      `$$\n${MATRIX.repeat(6)}\n$$`,
      `| a | b |\n|---|---|\n${"| $x$ | **y** |\n".repeat(20)}`,
      `- ${LEAD}\n- [link](https://example.com/${"x".repeat(300)})\n- ${LEAD}`,
    ];
    for (const reply of replies) {
      const source = markdownPreviewSource(reply, LIMIT);
      expect(source.length).toBeLessThanOrEqual(LIMIT);
      expect(source.length).toBeGreaterThan(0);
      expect(markdownPreviewText(source)).not.toMatch(/\*\*|\$\$|\]\(/u);
    }
  });
});

describe("a plain text prefix", () => {
  it("cuts by whole characters", () => {
    expect(textPrefix("ab👋🏽cd", 3)).toBe("ab");
    expect(textPrefix("ab👋🏽cd", 6)).toBe("ab👋🏽");
    expect(textPrefix("abc", 5)).toBe("abc");
  });
});

describe("a long question in the runtime snapshot", () => {
  it("is not cut inside a code span", () => {
    const question = `${LEAD}${LEAD}Which target should I use: \`deploy --target production-eu-west --region-fallback us-east --no-cache --verbose\` or staging?`;
    const compact = compactRuntimeQuestion({ id: "q1", header: "Target", question, isSecret: false, options: null });
    expect(compact.question.length).toBeLessThanOrEqual(240);
    expect(markdownPreviewText(compact.question)).not.toContain("`");
  });
});
