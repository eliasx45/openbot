import type { FilePreview } from "@openbot/contracts/ipc";
import FilePreviewPanel from "@openbot/ui/features/conversation/FilePreviewPanel";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const TEXT = "Name;Price\nCafé;3 €\nÜber;12 €\n";

function utf16(text: string, byteOrder: "le" | "be"): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set(byteOrder === "le" ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const high = code >> 8;
    const low = code & 0xff;
    bytes.set(byteOrder === "le" ? [low, high] : [high, low], 2 + index * 2);
  }
  return bytes;
}

function showFile(name: string, bytes: Uint8Array, previewKind: FilePreview["previewKind"] = "text") {
  const mimeType = previewKind === "markdown" ? "text/markdown" : "text/plain";
  const preview: FilePreview = { name, size: bytes.length, mimeType, previewKind, bytes };
  return render(() => (
    <FilePreviewPanel
      readWidth={() => 480}
      onResizeEnd={vi.fn()}
      onResetWidth={vi.fn()}
      readWrapLines={() => false}
      onWrapLinesChange={vi.fn()}
      preview={preview}
      agents={[]}
      maxWidth={() => 900}
      onWidthChange={vi.fn()}
      onOpenLink={vi.fn()}
      onOpenSharedFile={vi.fn()}
      onOpenExternally={vi.fn()}
      onClose={vi.fn()}
    />
  ));
}

function shownSource(container: HTMLElement): string {
  return container.querySelector("pre")?.textContent ?? "";
}

describe("a text file in the file panel", () => {
  it("reads UTF-8", () => {
    const { container } = showFile("prices.txt", new TextEncoder().encode(TEXT));
    expect(shownSource(container)).toBe(TEXT);
  });

  it("reads UTF-16 with a little-endian byte order mark, as PowerShell and Excel write it", () => {
    const { container } = showFile("prices.txt", utf16(TEXT, "le"));
    expect(shownSource(container)).toBe(TEXT);
  });

  it("reads UTF-16 with a big-endian byte order mark", () => {
    const { container } = showFile("prices.txt", utf16(TEXT, "be"));
    expect(shownSource(container)).toBe(TEXT);
  });
});

const SKILL = `---
name: pdf-tools
description: Fill and merge PDF forms.
---
# PDF tools

Use it for forms.
`;

describe("a Markdown file with YAML front matter", () => {
  it("shows the front matter as YAML, not as a heading", async () => {
    const { container } = showFile("SKILL.md", new TextEncoder().encode(SKILL), "markdown");
    expect(screen.getByRole("heading", { level: 1, name: "PDF tools" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /name: pdf-tools/u })).toBeNull();
    expect(container.querySelector("article hr")).toBeNull();
    await waitFor(() =>
      expect(container.querySelector("article pre")?.textContent).toContain("description: Fill and merge PDF forms."),
    );
  });

  it("keeps a horizontal rule and a heading that do not hold YAML keys", () => {
    const { container } = showFile("notes.md", new TextEncoder().encode("---\nJust a line\n---\n\nText\n"), "markdown");
    expect(container.querySelector("article hr")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Just a line" })).toBeTruthy();
  });
});

describe("a Markdown file longer than the preview limit", () => {
  it("says that the source view is cut, as the rendered view does", async () => {
    const { container } = showFile("long.md", new TextEncoder().encode(`${"a".repeat(1_000_100)}\n`), "markdown");
    expect(screen.getByText(/Preview truncated after/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show Markdown source" }));
    await waitFor(() => expect(container.querySelector("article")).toBeNull());
    expect(container.querySelector("pre")?.textContent?.length).toBe(1_000_000);
    expect(screen.getByText(/Preview truncated after/u)).toBeTruthy();
  });
});
