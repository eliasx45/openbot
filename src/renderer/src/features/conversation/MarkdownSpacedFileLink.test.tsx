import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

it("opens a local file whose link target has spaces without angle brackets", () => {
  const onOpenSharedFile = vi.fn();
  const onOpenWorkspaceFile = vi.fn();
  render(() => (
    <MarkdownMessageText
      body={[
        "The [weekly report](/Users/test/OpenBot/Shared/my report.md) is ready.",
        "",
        "Logs: [main log](/Users/test/Library/Application Support/OpenBot/main.log), and `[x](/a b.md)` stays code.",
        "",
        "![Shop front](/Users/test/OpenBot/Shared/shop front.png)",
      ].join("\n")}
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onOpenSharedFile={onOpenSharedFile}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "Open shared file my report.md" }));
  expect(onOpenSharedFile).toHaveBeenCalledWith("/Users/test/OpenBot/Shared/my report.md");
  fireEvent.click(screen.getByRole("button", { name: "Open workspace file main.log" }));
  expect(onOpenWorkspaceFile).toHaveBeenCalledWith("/Users/test/Library/Application Support/OpenBot/main.log");
  fireEvent.click(screen.getByRole("button", { name: "Open shared file shop front.png" }));
  expect(onOpenSharedFile).toHaveBeenLastCalledWith("/Users/test/OpenBot/Shared/shop front.png");
  expect(screen.getByText("[x](/a b.md)")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open shared file my" })).toBeNull();
});
