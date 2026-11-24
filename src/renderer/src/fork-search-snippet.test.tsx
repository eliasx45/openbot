import { messagePreview } from "@openbot/ui/components/GlobalSearch";
import type { AgentMessage } from "@openbot/ui/data";
import { describe, expect, it } from "vitest";

function message(body: string): AgentMessage {
  return { id: "m1", author: "agent", body, time: "10:00", attachments: [] };
}

describe("a message in search results", () => {
  it("shows the message as one line of plain text", () => {
    const body = [
      "## Deploy notes",
      "",
      "**Root cause:** the cache drops writes. See [the report](https://example.com/report).<br>",
      "",
      "$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$",
      "",
      "```ts",
      "const ttl = 0;",
      "```",
      "",
      "Compare @[notes.pdf](attachment:att-1) with the plan.",
    ].join("\n");
    const text = messagePreview(message(body));
    expect(text).not.toMatch(/\*\*|##|<br>|\]\(|```|\$\$|@\[/u);
    expect(text).toContain("Root cause: the cache drops writes. See the report.");
    expect(text).toContain("Compare notes.pdf with the plan.");
  });

  it("keeps a quote tag as the quoted name", () => {
    expect(messagePreview(message("About @[the plan](quote:msg-1), yes."))).toBe("About “the plan”, yes.");
  });
});
