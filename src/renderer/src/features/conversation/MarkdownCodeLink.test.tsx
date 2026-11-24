import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { fireEvent, render } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

it("opens only the web page when a link's text is a file name in code", () => {
  const onOpenLink = vi.fn();
  const onOpenWorkspaceFile = vi.fn();
  const onOpenSharedFile = vi.fn();
  const { container } = render(() => (
    <MarkdownMessageText
      body="See [`run.ts`](https://example.com/run.ts) and [`~/OpenBot/Shared/a.md`](https://example.com/a)."
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={onOpenLink}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
      onOpenSharedFile={onOpenSharedFile}
    />
  ));
  const links = [...container.querySelectorAll("a.message-link")];
  expect(links.map((link) => link.textContent)).toEqual(["run.ts", "~/OpenBot/Shared/a.md"]);
  for (const link of links) {
    expect(link.querySelector("button")).toBeNull();
    const code = link.querySelector("code");
    if (!code) throw new Error("no code in the link");
    fireEvent.click(code);
  }
  expect(onOpenLink.mock.calls).toEqual([["https://example.com/run.ts"], ["https://example.com/a"]]);
  expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  expect(onOpenSharedFile).not.toHaveBeenCalled();
});
