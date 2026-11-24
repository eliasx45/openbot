import type { DraftAttachment } from "@openbot/contracts/ipc";
import { ComposerAttachmentRow } from "@openbot/ui/features/conversation/ComposerAttachmentRow";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

function file(name: string): DraftAttachment {
  return {
    id: `attachment-${name}`,
    name,
    size: 1_024,
    kind: "file",
    mimeType: "application/octet-stream",
    previewKind: "none",
    previewUrl: null,
  };
}

function badges(names: string[]): string[] {
  const { container } = render(() => <ComposerAttachmentRow attachments={names.map(file)} onRemove={vi.fn()} />);
  return Array.from(container.querySelectorAll("span.composer-attachment-preview"), (badge) => badge.textContent ?? "");
}

describe("the badge of a file in the message box", () => {
  it("shows the extension of the file", () => {
    expect(badges(["archive.tar.gz", "notes.key", ".env"])).toEqual(["GZ", "KEY", "ENV"]);
  });

  it("shows FILE for a name without an extension, not the start of the name", () => {
    expect(badges(["LICENSE", "README", "build."])).toEqual(["FILE", "FILE", "FILE"]);
  });
});
