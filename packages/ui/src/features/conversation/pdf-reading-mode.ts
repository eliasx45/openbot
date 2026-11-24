import type { AppTextKey } from "@openbot/i18n";
import type { Component } from "solid-js";

export const PDF_READING_MODES = ["off", "dark", "sepia"] as const;

export type PdfReadingMode = (typeof PDF_READING_MODES)[number];

export type PdfPaperMode = Exclude<PdfReadingMode, "off">;

export const PDF_READING_MODE_LABEL = {
  off: "preview.reading.off",
  dark: "preview.reading.dark",
  sepia: "preview.reading.sepia",
} as const satisfies Record<PdfReadingMode, AppTextKey>;

export function pdfReadingMode(value: string | null | undefined): PdfReadingMode {
  return PDF_READING_MODES.find((mode) => mode === value) ?? "off";
}

export interface PdfPaperReaderProps {
  bytes: Uint8Array | null;
  url: string | null;
  title: string;
  mode: PdfPaperMode;
  onOpenLink: (url: string) => void;
}

export type PdfPaperReader = Component<PdfPaperReaderProps>;
