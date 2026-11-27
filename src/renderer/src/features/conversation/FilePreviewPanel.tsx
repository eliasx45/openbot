import SharedFilePreviewPanel from "@openbot/ui/features/conversation/FilePreviewPanel";
import { parseFilePreviewBrightness } from "@openbot/ui/features/conversation/file-preview-brightness";
import { pdfReadingMode } from "@openbot/ui/features/conversation/pdf-reading-mode";
import type { ComponentProps } from "@solidjs/web";
import { readSidePanelWidth, resetSidePanelWidth, saveSidePanelWidth } from "../../components/side-panel-width";
import PdfPaperReader from "./PdfPaperReader";
import { readPdfPosition, savePdfPosition } from "./pdf-positions";

const WRAP_LINES_STORAGE_KEY = "openbot:file-preview-wrap-lines";
export const BRIGHTNESS_STORAGE_KEY = "openbot:file-preview-brightness";
export const READING_MODE_STORAGE_KEY = "openbot:file-preview-reading-mode";

export default function FilePreviewPanel(
  props: Omit<
    ComponentProps<typeof SharedFilePreviewPanel>,
    | "readWidth"
    | "onResizeEnd"
    | "onResetWidth"
    | "readWrapLines"
    | "onWrapLinesChange"
    | "readBrightness"
    | "onBrightnessChange"
    | "readReadingMode"
    | "onReadingModeChange"
    | "pdfReader"
    | "readPdfPosition"
    | "onPdfPositionChange"
  >,
) {
  return (
    <SharedFilePreviewPanel
      {...props}
      readWidth={readSidePanelWidth}
      onResetWidth={resetSidePanelWidth}
      onResizeEnd={saveSidePanelWidth}
      readWrapLines={() => window.localStorage.getItem(WRAP_LINES_STORAGE_KEY) === "true"}
      onWrapLinesChange={(wrap) => window.localStorage.setItem(WRAP_LINES_STORAGE_KEY, String(wrap))}
      readBrightness={() => parseFilePreviewBrightness(window.localStorage.getItem(BRIGHTNESS_STORAGE_KEY))}
      onBrightnessChange={(brightness) => window.localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(brightness))}
      readReadingMode={() => pdfReadingMode(window.localStorage.getItem(READING_MODE_STORAGE_KEY))}
      onReadingModeChange={(mode) => window.localStorage.setItem(READING_MODE_STORAGE_KEY, mode)}
      pdfReader={PdfPaperReader}
      readPdfPosition={readPdfPosition}
      onPdfPositionChange={savePdfPosition}
    />
  );
}
