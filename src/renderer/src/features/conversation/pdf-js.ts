import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline";

type PdfJs = typeof import("pdfjs-dist");
type PdfViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs");

let pdfJs: Promise<PdfJs> | undefined;
let pdfViewer: Promise<{ lib: PdfJs; viewer: PdfViewerModule }> | undefined;

export function loadPdfJs(): Promise<PdfJs> {
  pdfJs ??= import("pdfjs-dist").then((module) => {
    module.GlobalWorkerOptions.workerSrc = workerUrl;
    return module;
  });
  return pdfJs;
}

export function loadPdfViewer(): Promise<{ lib: PdfJs; viewer: PdfViewerModule }> {
  pdfViewer ??= loadPdfJs().then(async (lib) => {
    Object.assign(globalThis, { pdfjsLib: lib });
    return { lib, viewer: await import("pdfjs-dist/web/pdf_viewer.mjs") };
  });
  return pdfViewer;
}
