import type { PdfViewerPosition } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { PdfPosition } from "@openbot/ui/features/conversation/pdf-reading-mode";

const PDF_POSITIONS_STORAGE_KEY = "openbot:file-preview-pdf-positions";
const PDF_FRAME_POSITIONS_STORAGE_KEY = "openbot:file-preview-pdf-frame-positions";
const POSITION_LIMIT = 200;

export function pdfPositionKey(ownerAgentId: string, fileKey: string | undefined): string | undefined {
  return fileKey ? `${ownerAgentId}\u0000${fileKey}` : undefined;
}

export interface PdfPageBox {
  top: number;
  height: number;
}

export function pdfScrollPosition(viewTop: number, pages: readonly PdfPageBox[]): Omit<PdfPosition, "scale"> | null {
  if (pages.length === 0) return null;
  let index = pages.findIndex((page) => page.top + page.height > viewTop);
  if (index < 0) index = pages.length - 1;
  const page = pages[index];
  if (!page) return null;
  const offset = page.height > 0 ? (viewTop - page.top) / page.height : 0;
  return { page: index + 1, offset: Math.min(1, Math.max(0, offset)) };
}

export function pdfScrollDelta(
  position: Pick<PdfPosition, "page" | "offset">,
  viewTop: number,
  pages: readonly PdfPageBox[],
): number | null {
  const page = pages[Math.min(pages.length, Math.max(1, position.page)) - 1];
  if (!page) return null;
  return page.top + position.offset * page.height - viewTop;
}

function decodePosition(value: unknown): PdfPosition | null {
  if (!isDynamicRecord(value)) return null;
  const { page, offset, scale } = value;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
  if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
  if (scale !== null && (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0)) return null;
  return { page, offset: Math.min(1, Math.max(0, offset)), scale };
}

function decodePositions(value: unknown): Map<string, PdfPosition> {
  const positions = new Map<string, PdfPosition>();
  if (!Array.isArray(value)) return positions;
  for (const entry of value) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const position = decodePosition(entry[1]);
    if (position) positions.set(entry[0], position);
  }
  return positions;
}

export function parsePdfPositions(raw: string | null): Map<string, PdfPosition> {
  if (!raw) return new Map();
  try {
    return decodePositions(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

export function rememberPdfPosition(
  positions: Map<string, PdfPosition>,
  key: string,
  position: PdfPosition,
  limit = POSITION_LIMIT,
): void {
  positions.delete(key);
  positions.set(key, position);
  for (const oldest of positions.keys()) {
    if (positions.size <= limit) break;
    positions.delete(oldest);
  }
}

let stored: Map<string, PdfPosition> | undefined;

function storedPositions(): Map<string, PdfPosition> {
  stored ??= parsePdfPositions(window.localStorage.getItem(PDF_POSITIONS_STORAGE_KEY));
  return stored;
}

export function readPdfPosition(key: string): PdfPosition | null {
  return storedPositions().get(key) ?? null;
}

export function savePdfPosition(key: string, position: PdfPosition): void {
  const positions = storedPositions();
  rememberPdfPosition(positions, key, position);
  try {
    window.localStorage.setItem(PDF_POSITIONS_STORAGE_KEY, JSON.stringify([...positions]));
  } catch {}
}

function decodeFramePosition(value: unknown): PdfViewerPosition | null {
  if (!isDynamicRecord(value)) return null;
  const { x, y, zoom } = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof zoom !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) return null;
  return { x, y, zoom };
}

function decodeFramePositions(value: unknown): Map<string, PdfViewerPosition> {
  const positions = new Map<string, PdfViewerPosition>();
  if (!Array.isArray(value)) return positions;
  for (const entry of value) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const position = decodeFramePosition(entry[1]);
    if (position) positions.set(entry[0], position);
  }
  return positions;
}

function parsePdfFramePositions(raw: string | null): Map<string, PdfViewerPosition> {
  if (!raw) return new Map();
  try {
    return decodeFramePositions(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

let storedFrames: Map<string, PdfViewerPosition> | undefined;

function storedFramePositions(): Map<string, PdfViewerPosition> {
  storedFrames ??= parsePdfFramePositions(window.localStorage.getItem(PDF_FRAME_POSITIONS_STORAGE_KEY));
  return storedFrames;
}

export function readPdfFramePosition(key: string): PdfViewerPosition | null {
  return storedFramePositions().get(key) ?? null;
}

function samePdfFramePosition(left: PdfViewerPosition | null, right: PdfViewerPosition): boolean {
  return left !== null && left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

export function savePdfFramePosition(key: string, position: PdfViewerPosition): void {
  const positions = storedFramePositions();
  if (samePdfFramePosition(positions.get(key) ?? null, position)) return;
  positions.delete(key);
  positions.set(key, position);
  for (const oldest of positions.keys()) {
    if (positions.size <= POSITION_LIMIT) break;
    positions.delete(oldest);
  }
  try {
    window.localStorage.setItem(PDF_FRAME_POSITIONS_STORAGE_KEY, JSON.stringify([...positions]));
  } catch {}
}
