import type { DraftAttachment } from "@openbot/contracts/ipc";
import { ComposerAttachmentRow } from "@openbot/ui/features/conversation/ComposerAttachmentRow";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

const image = (id: string): DraftAttachment => ({
  id,
  name: `${id}.png`,
  size: 10,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: `data:image/png;base64,${id}`,
});

// An image in the message box, not sent yet, opens in the same viewer as a sent one.
it("opens an unsent image in the image viewer", async () => {
  // jsdom has no Web Animations; the viewer animates its opening from the thumbnail.
  if (!("animate" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => ({ finished: Promise.resolve(), cancel: vi.fn(), finish: vi.fn() }),
    });
  }
  render(() => <ComposerAttachmentRow attachments={[image("a"), image("b")]} onRemove={vi.fn()} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  const thumbnails = document.querySelectorAll<HTMLButtonElement>(".composer-attachment-preview");
  expect(thumbnails).toHaveLength(2);
  const second = thumbnails[1];
  if (!second) throw new Error("no thumbnail");
  fireEvent.click(second);
  expect(await screen.findByRole("dialog")).toBeTruthy();
});
