import type { AgentMessage } from "@openbot/ui/data";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

const LOGO_URL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

function reply(body: string): AgentMessage {
  return { id: "local-image-reply", author: "agent", body, time: "12:00", attachments: [] };
}

it("shows a Markdown image of a local file as the file and loads the picture", async () => {
  const loadImageFile = vi.fn((file: { path: string }) =>
    Promise.resolve(file.path.endsWith("logo.svg") ? LOGO_URL : null),
  );
  const onOpenSharedFile = vi.fn();
  const onOpenWorkspaceFile = vi.fn();
  render(() => (
    <MessageBody
      message={reply(
        "The logo:\n\n![Logo](/Users/test/OpenBot/Shared/brand/logo.svg)\n\nThe draft: ![](app/draft.png)",
      )}
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onPreview={vi.fn()}
      onAttachmentAction={vi.fn()}
      onOpenSharedFile={onOpenSharedFile}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
      loadImageFile={loadImageFile}
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "Open shared file logo.svg" }));
  expect(onOpenSharedFile).toHaveBeenCalledWith("/Users/test/OpenBot/Shared/brand/logo.svg");
  fireEvent.click(screen.getByRole("button", { name: "Open workspace file draft.png" }));
  expect(onOpenWorkspaceFile).toHaveBeenCalledWith("app/draft.png");
  expect(screen.queryByText("![](app/draft.png)")).toBeNull();

  expect(loadImageFile.mock.calls.map(([file]) => file)).toEqual([
    { path: "/Users/test/OpenBot/Shared/brand/logo.svg", kind: "shared" },
    { path: "app/draft.png", kind: "workspace" },
  ]);
  expect(await screen.findByRole("button", { name: "Preview logo.svg" })).toBeTruthy();
});
