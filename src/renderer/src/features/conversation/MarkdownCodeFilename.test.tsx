import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { render, screen, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

it("names the file of a tilde fence and of a fence in a quote", () => {
  const body = ["~~~python app/main.py", "print(1)", "~~~", "", "> ```ts src/run.ts", "> run();", "> ```"].join("\n");
  render(() => <MarkdownMessageText body={body} agents={[]} onSelectAgent={vi.fn()} onOpenLink={vi.fn()} />);

  const python = screen.getByRole("region", { name: "Python code block" });
  const typescript = screen.getByRole("region", { name: "TypeScript code block" });
  expect(within(python).getByText("app/main.py")).toBeTruthy();
  expect(within(typescript).getByText("src/run.ts")).toBeTruthy();
});
