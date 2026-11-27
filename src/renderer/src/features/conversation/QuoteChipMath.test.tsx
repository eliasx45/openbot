// Fork (docs/fork/FEATURES.md #127): a quote chip in a sent message showed the LaTeX source of the
// quoted formula (`$\ker f=\{0\}$`, Owl chat, 27 Nov 2026). The chip now typesets the math, and its
// tooltip keeps the source.
import { serializeChatTagReference } from "@openbot/contracts/chat-tag-references";
import { RichMessageText } from "@openbot/ui/features/conversation/RichMessageText";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  document.body.innerHTML = "";
});

function sent(quote: string, typed: string) {
  const body = `${serializeChatTagReference("quote", quote, "message-1")} ${typed}`;
  render(() => (
    <RichMessageText body={body} agents={[]} onSelectAgent={() => {}} onOpenLink={() => {}} onOpenQuote={() => {}} />
  ));
  return screen.getByRole("button", { name: `Show quoted text ${quote}` });
}

describe("quote chip math", () => {
  it("typesets the quoted formula and keeps its source in the tooltip", async () => {
    const chip = sent("$\\ker f=\\{0\\}$", "why?");
    const math = await waitFor(() => within(chip).getByRole("math"), { timeout: 5_000 });
    expect(math.textContent).toContain("\\ker f=\\{0\\}");
    expect(chip.textContent).not.toContain("$");
    expect(chip.getAttribute("title")).toBe("$\\ker f=\\{0\\}$");
    expect(screen.getByText("why?", { exact: false })).toBeTruthy();
  });

  it("keeps a plain quote and the text around the math", async () => {
    const plain = sent("only the zero vector", "ok");
    expect(plain.textContent).toContain("only the zero vector");
    expect(within(plain).queryByRole("math")).toBeNull();
    document.body.innerHTML = "";
    const mixed = sent("so $x=0$ here", "ok");
    await waitFor(() => within(mixed).getByRole("math"), { timeout: 5_000 });
    expect(mixed.textContent).toContain("so ");
    expect(mixed.textContent).toContain(" here");
    expect(mixed.textContent).not.toContain("$");
  });
});
