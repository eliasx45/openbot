import type { FilePreview } from "@openbot/contracts/ipc";
import {
  clampFilePreviewBrightness,
  filePreviewCanDim,
  parseFilePreviewBrightness,
} from "@openbot/ui/features/conversation/file-preview-brightness";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilePreviewPanel, { BRIGHTNESS_STORAGE_KEY, READING_MODE_STORAGE_KEY } from "./FilePreviewPanel";

const PDF: FilePreview = {
  name: "worksheet.pdf",
  size: 4,
  mimeType: "application/pdf",
  previewKind: "pdf",
  bytes: new Uint8Array([37, 80, 68, 70]),
};

const IMAGE: FilePreview = {
  name: "diagram.png",
  size: 4,
  mimeType: "image/png",
  previewKind: "image",
  bytes: new Uint8Array([137, 80, 78, 71]),
};

const MARKDOWN: FilePreview = {
  name: "notes.md",
  size: 7,
  mimeType: "text/markdown",
  previewKind: "markdown",
  bytes: new TextEncoder().encode("# Notes"),
};

function showPanel(preview: FilePreview) {
  render(() => (
    <FilePreviewPanel
      preview={preview}
      sourceUrl="openbot-attachment://file/worksheet"
      agents={[]}
      maxWidth={() => 900}
      onWidthChange={vi.fn()}
      onOpenLink={vi.fn()}
      onOpenSharedFile={vi.fn()}
      onOpenExternally={vi.fn()}
      onClose={vi.fn()}
    />
  ));
  flush();
  const content = document.querySelector<HTMLElement>(".file-preview-content");
  if (!content) throw new Error("no preview content");
  return content;
}

afterEach(() => {
  window.localStorage.clear();
});

describe("file preview brightness value", () => {
  it("keeps a saved value between 40 and 100 and falls back to full brightness", () => {
    expect(parseFilePreviewBrightness(null)).toBe(100);
    expect(parseFilePreviewBrightness("")).toBe(100);
    expect(parseFilePreviewBrightness("dim")).toBe(100);
    expect(parseFilePreviewBrightness("62.4")).toBe(62);
    expect(parseFilePreviewBrightness("10")).toBe(40);
    expect(parseFilePreviewBrightness("180")).toBe(100);
    expect(clampFilePreviewBrightness(Number.NaN)).toBe(100);
  });

  it("dims PDFs, images and rendered pages, not text or source", () => {
    const view = { hasPage: false, rawSource: false };
    expect(filePreviewCanDim({ ...view, kind: "pdf" })).toBe(true);
    expect(filePreviewCanDim({ ...view, kind: "image" })).toBe(true);
    expect(filePreviewCanDim({ ...view, kind: "text", hasPage: true })).toBe(true);
    expect(filePreviewCanDim({ ...view, kind: "text", hasPage: true, rawSource: true })).toBe(false);
    expect(filePreviewCanDim({ ...view, kind: "markdown" })).toBe(false);
    expect(filePreviewCanDim({ ...view, kind: "text" })).toBe(false);
  });
});

describe("file preview panel dimmer", () => {
  it("applies the saved brightness to a PDF and saves the reset", async () => {
    window.localStorage.setItem(BRIGHTNESS_STORAGE_KEY, "60");
    const content = showPanel(PDF);
    expect(content.hasAttribute("data-dimmed")).toBe(true);
    expect(content.style.getPropertyValue("--file-preview-brightness")).toBe("0.6");

    fireEvent.click(screen.getByRole("button", { name: "Brightness" }));
    flush();
    const slider = await screen.findByRole("slider", { name: "Brightness" });
    expect(slider.getAttribute("aria-valuetext")).toBe("60%");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    flush();
    expect(window.localStorage.getItem(BRIGHTNESS_STORAGE_KEY)).toBe("100");
    expect(content.hasAttribute("data-dimmed")).toBe(false);
    expect(content.style.getPropertyValue("--file-preview-brightness")).toBe("");
    expect(slider).toHaveFocus();
  });

  it("lets Escape close only the dimmer, not the side panel", async () => {
    showPanel(PDF);
    fireEvent.click(screen.getByRole("button", { name: "Brightness" }));
    flush();
    await screen.findByRole("slider", { name: "Brightness" });
    const escapeKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escapeKey);
    flush();
    expect(escapeKey.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(screen.queryByRole("slider", { name: "Brightness" })).toBeNull());
  });

  it("shows no dimmer for a Markdown file", () => {
    window.localStorage.setItem(BRIGHTNESS_STORAGE_KEY, "60");
    const content = showPanel(MARKDOWN);
    expect(screen.queryByRole("button", { name: "Brightness" })).toBeNull();
    expect(content.hasAttribute("data-dimmed")).toBe(false);
  });
});

describe("page colors with the brightness slider", () => {
  it("keeps the saved brightness on the Dark paper reader", async () => {
    window.localStorage.setItem(READING_MODE_STORAGE_KEY, "dark");
    window.localStorage.setItem(BRIGHTNESS_STORAGE_KEY, "70");
    const content = showPanel(PDF);
    expect(screen.getByRole("region", { name: PDF.name })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "PDF controls" })).toBeInTheDocument();
    expect(content.querySelector("iframe")).toBeNull();
    expect(content.hasAttribute("data-dimmed")).toBe(true);
    expect(content.style.getPropertyValue("--file-preview-brightness")).toBe("0.7");

    fireEvent.click(screen.getByRole("button", { name: "Brightness" }));
    flush();
    const slider = await screen.findByRole("slider", { name: "Brightness" });
    expect(slider.getAttribute("aria-valuetext")).toBe("70%");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    flush();
    expect(content.style.getPropertyValue("--file-preview-brightness")).toBe("0.69");
    fireEvent.keyDown(slider, { key: "Escape" });
    flush();
    await vi.waitFor(() => expect(screen.queryByRole("slider", { name: "Brightness" })).toBeNull());
    expect(window.localStorage.getItem(READING_MODE_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(BRIGHTNESS_STORAGE_KEY)).toBe("69");
  });

  it("shows the brightness slider without page colors for an image", () => {
    window.localStorage.setItem(BRIGHTNESS_STORAGE_KEY, "60");
    const content = showPanel(IMAGE);
    expect(screen.getByRole("button", { name: "Brightness" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Page colors" })).toBeNull();
    expect(content.hasAttribute("data-dimmed")).toBe(true);
  });

  it("opens one header popup at a time and Escape closes only that one", async () => {
    showPanel(PDF);
    fireEvent.click(screen.getByRole("button", { name: "Brightness" }));
    flush();
    await screen.findByRole("slider", { name: "Brightness" });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Page colors" }), { button: 0, pointerType: "mouse" });
    flush();
    await screen.findByRole("menu", { name: "Page colors" });
    await vi.waitFor(() => expect(screen.queryByRole("slider", { name: "Brightness" })).toBeNull());

    const escapeKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escapeKey);
    flush();
    expect(escapeKey.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(screen.queryByRole("menu", { name: "Page colors" })).toBeNull());
    expect(window.localStorage.getItem(READING_MODE_STORAGE_KEY)).toBeNull();
  });
});
