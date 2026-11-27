import { isPdfViewerPosition, type PdfViewerPosition } from "@openbot/contracts/ipc";
import type { WebContents, WebFrameMain } from "electron";

const PDF_VIEWER_ORIGIN = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";

const READ_POSITION = `(() => {
  const viewer = document.querySelector("pdf-viewer");
  const viewport = viewer && viewer.viewport_;
  if (!viewport || viewer.loadProgress_ !== 100) return null;
  const position = viewport.position;
  return { x: position.x, y: position.y, zoom: viewport.getZoom() };
})()`;

function restorePosition(position: PdfViewerPosition): string {
  return `(() => {
  const viewer = document.querySelector("pdf-viewer");
  const viewport = viewer && viewer.viewport_;
  if (!viewport || viewer.loadProgress_ !== 100) return false;
  viewport.setZoom(${position.zoom});
  viewport.setPosition({ x: ${position.x}, y: ${position.y} + 1 });
  viewport.setPosition({ x: ${position.x}, y: ${position.y} });
  return true;
})()`;
}

export function pdfViewerFrameFor(frames: readonly WebFrameMain[], url: string): WebFrameMain | null {
  return (
    frames.find(
      (frame) => frame.url.startsWith(PDF_VIEWER_ORIGIN) && frame.parent !== null && frame.parent.url === url,
    ) ?? null
  );
}

function viewerFrame(contents: WebContents, url: string): WebFrameMain | null {
  if (contents.isDestroyed()) return null;
  return pdfViewerFrameFor(contents.mainFrame.framesInSubtree, url);
}

export async function readPdfViewerPosition(contents: WebContents, url: string): Promise<PdfViewerPosition | null> {
  const frame = viewerFrame(contents, url);
  if (!frame) return null;
  try {
    const value = await frame.executeJavaScript(READ_POSITION);
    return isPdfViewerPosition(value) ? value : null;
  } catch {
    return null;
  }
}

export async function restorePdfViewerPosition(
  contents: WebContents,
  url: string,
  position: PdfViewerPosition,
): Promise<boolean> {
  const frame = viewerFrame(contents, url);
  if (!frame || !isPdfViewerPosition(position)) return false;
  try {
    return (await frame.executeJavaScript(restorePosition(position))) === true;
  } catch {
    return false;
  }
}
