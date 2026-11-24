import type { FilePreview } from "@openbot/contracts/ipc";

export const FILE_PREVIEW_BRIGHTNESS_MIN = 40;
export const FILE_PREVIEW_BRIGHTNESS_MAX = 100;

export function clampFilePreviewBrightness(value: number): number {
  if (!Number.isFinite(value)) return FILE_PREVIEW_BRIGHTNESS_MAX;
  return Math.min(FILE_PREVIEW_BRIGHTNESS_MAX, Math.max(FILE_PREVIEW_BRIGHTNESS_MIN, Math.round(value)));
}

export function parseFilePreviewBrightness(stored: string | null): number {
  if (stored === null || stored.trim() === "") return FILE_PREVIEW_BRIGHTNESS_MAX;
  return clampFilePreviewBrightness(Number(stored));
}

export function isFilePreviewDimmed(brightness: number): boolean {
  return clampFilePreviewBrightness(brightness) < FILE_PREVIEW_BRIGHTNESS_MAX;
}

export function filePreviewBrightnessStyle(brightness: number): Record<string, string> | undefined {
  if (!isFilePreviewDimmed(brightness)) return undefined;
  return { "--file-preview-brightness": String(clampFilePreviewBrightness(brightness) / FILE_PREVIEW_BRIGHTNESS_MAX) };
}

export function filePreviewCanDim(view: {
  kind: FilePreview["previewKind"] | undefined;
  hasPage: boolean;
  rawSource: boolean;
}): boolean {
  if (view.rawSource) return false;
  return view.kind === "pdf" || view.kind === "image" || view.hasPage;
}
