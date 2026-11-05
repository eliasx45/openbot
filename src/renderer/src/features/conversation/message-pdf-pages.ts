import type { FileChipPeek, MessageImageFile } from "@openbot/ui/features/conversation/MarkdownMessageText";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline";
import { releaseFilePreviewPage } from "./conversation-port";
import type { ConversationRuntime } from "./conversation-runtime";

/** A larger PDF gets no peek: the host does not read or send a larger file for it. */
const PEEK_PDF_BYTES = 32 * 1024 * 1024;
/** The page picture width in CSS pixels, the width of the peek. */
const PEEK_WIDTH = 320;
/** Sharper than this costs memory for no visible gain in a peek. */
const MAX_PIXEL_RATIO = 2;
/** The cached `data:` pictures together take at most this many characters. */
const CACHE_CHARACTERS = 32 * 1024 * 1024;

type PdfJs = typeof import("pdfjs-dist");
let pdfJs: Promise<PdfJs> | undefined;

/** pdf.js loads on the first peek, so a chat with no PDF does not load it. */
function loadPdfJs(): Promise<PdfJs> {
  pdfJs ??= import("pdfjs-dist").then((module) => {
    module.GlobalWorkerOptions.workerSrc = workerUrl;
    return module;
  });
  return pdfJs;
}

interface Entry {
  job: Promise<FileChipPeek | null>;
  stop: AbortController;
  /** The open peeks that wait for the job. When the last one closes before the answer, the job stops. */
  waiting: number;
  settled: boolean;
  characters: number;
}

/**
 * Draws one page of the PDF files that agent messages name, for the peek over their chips. The file
 * comes through the same file preview as the chip, and pdf.js draws the page, as the mobile app
 * draws a PDF. Each message keeps its own entry: an agent can write the same path again, and a newer
 * message must show the newer file. One chip and page has at most one read at a time.
 */
export function createMessagePdfPages(
  agent: Pick<ConversationRuntime["agent"], "previewSharedFile" | "previewWorkspaceFile">,
) {
  // Insertion order is the use order: the first entry is the least recently used.
  const cache = new Map<string, Entry>();
  let total = 0;
  const drop = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    total -= entry.characters;
  };

  async function read(
    file: MessageImageFile,
    page: number,
    agentId: string | undefined,
    signal: AbortSignal,
  ): Promise<FileChipPeek | null> {
    if (file.kind === "workspace" && !agentId) return null;
    const preview =
      file.kind === "shared"
        ? await agent.previewSharedFile({ path: file.path, maxBytes: PEEK_PDF_BYTES })
        : await agent.previewWorkspaceFile({
            agentId: agentId ?? "",
            path: file.path,
            maxBytes: PEEK_PDF_BYTES,
            // The peek shows only the file that the answer names, not an older file with the same name.
            exactPath: true,
          });
    // A PDF has no page address. Release one anyway, so no preview page stays held for a peek.
    releaseFilePreviewPage(preview.pageUrl);
    if (preview.previewKind !== "pdf" || !preview.bytes || signal.aborted) return null;
    return drawPage(preview.bytes, page, signal);
  }

  return (
    file: MessageImageFile,
    page: number,
    scope: { serverId: string; messageId: string; agentId: string | undefined },
    signal: AbortSignal,
  ): Promise<FileChipPeek | null> => {
    const agentId = file.kind === "workspace" ? scope.agentId : "";
    const key = `${scope.serverId}:${scope.messageId}:${file.kind}:${agentId}:${file.path}#${page}`;
    let entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
    } else {
      const stop = new AbortController();
      const created: Entry = {
        // A file that does not show gets no peek until the chat opens again, so a hover does not ask
        // the host again.
        job: read(file, page, scope.agentId, stop.signal).catch(() => null),
        stop,
        waiting: 0,
        settled: false,
        characters: 0,
      };
      cache.set(key, created);
      void created.job.then((picture) => {
        created.settled = true;
        if (cache.get(key) !== created) return;
        created.characters = picture?.imageUrl.length ?? 0;
        total += created.characters;
        for (const oldKey of cache.keys()) {
          if (total <= CACHE_CHARACTERS || oldKey === key) break;
          drop(oldKey);
        }
      });
      entry = created;
    }
    const current = entry;
    if (current.settled) return current.job;
    current.waiting += 1;
    signal.addEventListener(
      "abort",
      () => {
        current.waiting -= 1;
        if (current.waiting > 0 || current.settled) return;
        // A fast hover-out: stop the drawing, and forget the entry so the next hover reads again.
        current.stop.abort();
        if (cache.get(key) === current) drop(key);
      },
      { once: true },
    );
    return current.job;
  };
}

/** Draws page `page` (the last page when the file is shorter) as a `data:` image. */
async function drawPage(bytes: Uint8Array, page: number, signal: AbortSignal): Promise<FileChipPeek | null> {
  const { getDocument } = await loadPdfJs();
  if (signal.aborted) return null;
  const task = getDocument({ data: bytes, useSystemFonts: true });
  const stop = () => void task.destroy();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const pdf = await task.promise;
    const shown = Math.min(Math.max(1, page), pdf.numPages);
    const pdfPage = await pdf.getPage(shown);
    const width = pdfPage.getViewport({ scale: 1 }).width;
    const ratio = Math.min(MAX_PIXEL_RATIO, Math.max(1, window.devicePixelRatio || 1));
    const viewport = pdfPage.getViewport({ scale: (PEEK_WIDTH * ratio) / width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await pdfPage.render({ canvas, viewport }).promise;
    if (signal.aborted) return null;
    // The renderer policy allows `data:` images and no object URL images.
    return {
      imageUrl: canvas.toDataURL("image/webp", 0.92),
      page: shown,
      pageCount: pdf.numPages,
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    signal.removeEventListener("abort", stop);
    void task.destroy();
  }
}
