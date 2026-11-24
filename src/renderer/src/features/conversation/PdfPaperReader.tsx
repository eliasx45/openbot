import {
  ArrowLeftRight,
  Button,
  ChevronDown,
  ChevronUp,
  LabelTooltip,
  LabelTooltipTrigger,
  Minus,
  Plus,
} from "@openbot/ui";
import type { PdfPaperMode, PdfPaperReaderProps } from "@openbot/ui/features/conversation/pdf-reading-mode";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { createEffect, createStore, onSettled, Show, untrack } from "solid-js";
import { loadPdfViewer } from "./pdf-js";
import { imageQuads, type PaperPalette, paperPalette, parseHexColour, recolourPage } from "./pdf-paper";

const FIT_WIDTH = "page-width";
const WHEEL_ZOOM_SPEED = 0.01;
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

interface PaperPageView {
  canvas: HTMLCanvasElement | null;
  imageCoordinates: ArrayLike<number> | null;
  reset: () => void;
}

interface PageRenderedEvent {
  source: PaperPageView;
  error: unknown;
}

function readPalette(element: HTMLElement, mode: PdfPaperMode): PaperPalette | null {
  const style = getComputedStyle(element);
  const paper = parseHexColour(style.getPropertyValue(`--openbot-reading-${mode}-paper`));
  const ink = parseHexColour(style.getPropertyValue(`--openbot-reading-${mode}-ink`));
  return paper && ink ? paperPalette(mode, paper, ink) : null;
}

function paintPage(page: PaperPageView, mode: PdfPaperMode, palette: PaperPalette | null) {
  const canvas = page.canvas;
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (palette && context && canvas.width > 0 && canvas.height > 0) {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    recolourPage(image.data, canvas.width, canvas.height, palette, imageQuads(page.imageCoordinates));
    context.putImageData(image, 0, 0);
  }
  canvas.dataset.paper = mode;
}

export default function PdfPaperReader(props: PdfPaperReaderProps) {
  const { t } = useText();
  const [view, setView] = createStore({ page: 1, pages: 0, scale: 1, fitWidth: true, failed: false });
  let root!: HTMLDivElement;
  let scroller!: HTMLDivElement;
  let pages!: HTMLDivElement;
  let viewer: PDFViewer | undefined;
  let mode: PdfPaperMode = untrack(() => props.mode);
  let palette: PaperPalette | null = null;

  const repaintAll = () => {
    if (!viewer) return;
    for (let index = 0; index < viewer.pagesCount; index += 1) {
      const page: PaperPageView = viewer.getPageView(index);
      page.reset();
    }
    viewer.update();
  };

  createEffect(
    () => props.mode,
    (next) => {
      mode = next;
      palette = readPalette(root, next);
      repaintAll();
    },
  );

  createEffect(
    () => ({ bytes: props.bytes, url: props.url }),
    ({ bytes, url }) => {
      let current = true;
      let destroy: (() => void) | undefined;
      setView((state) => {
        state.failed = false;
        state.pages = 0;
        state.page = 1;
      });
      void loadPdfViewer()
        .then(async ({ lib, viewer: module }) => {
          if (!current) return;
          if (!viewer) {
            const eventBus = new module.EventBus();
            const linkService = new module.PDFLinkService({ eventBus });
            const created = new module.PDFViewer({
              container: scroller,
              viewer: pages,
              eventBus,
              linkService,
              removePageBorders: true,
              annotationMode: lib.AnnotationMode.ENABLE,
              enableDetailCanvas: false,
              enableSelectionRendering: false,
              imagesRightClickMinSize: Number.MAX_SAFE_INTEGER,
            });
            linkService.setViewer(created);
            eventBus.on("pagesinit", () => {
              created.currentScaleValue = FIT_WIDTH;
            });
            eventBus.on("pagechanging", (event: { pageNumber: number }) => {
              setView((state) => {
                state.page = event.pageNumber;
              });
            });
            eventBus.on("scalechanging", (event: { scale: number; presetValue?: string }) => {
              setView((state) => {
                state.scale = event.scale;
                state.fitWidth = event.presetValue === FIT_WIDTH;
              });
            });
            eventBus.on("pagerendered", (event: PageRenderedEvent) => {
              if (!event.error) paintPage(event.source, mode, palette);
            });
            viewer = created;
            palette ??= readPalette(root, mode);
          }
          const shown = viewer;
          const task = lib.getDocument(bytes ? { data: bytes.slice() } : { url: url ?? "" });
          destroy = () => void task.destroy();
          const pdf = await task.promise;
          if (!current) return;
          shown.setDocument(pdf);
          shown.linkService.setDocument(pdf);
          setView((state) => {
            state.pages = pdf.numPages;
          });
        })
        .catch(() => {
          if (current) {
            setView((state) => {
              state.failed = true;
            });
          }
        });
      return () => {
        current = false;
        destroy?.();
      };
    },
  );

  const openLink = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement)) return;
    const href = link.getAttribute("href") ?? "";
    if (!URL.canParse(href) || !LINK_PROTOCOLS.has(new URL(href).protocol)) return;
    event.preventDefault();
    event.stopPropagation();
    props.onOpenLink(href);
  };

  onSettled(() => {
    const resize = new ResizeObserver(() => {
      if (viewer && view.fitWidth && view.pages > 0) viewer.currentScaleValue = FIT_WIDTH;
    });
    resize.observe(scroller);
    const zoom = (event: WheelEvent) => {
      if (!viewer || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      viewer.updateScale({
        scaleFactor: Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED),
        origin: [event.clientX, event.clientY],
      });
    };
    scroller.addEventListener("wheel", zoom, { passive: false });
    scroller.addEventListener("click", openLink);
    return () => {
      resize.disconnect();
      scroller.removeEventListener("wheel", zoom);
      scroller.removeEventListener("click", openLink);
      viewer?.setDocument(null);
    };
  });

  return (
    <div ref={root} class="pdf-paper-reader" data-mode={props.mode}>
      <div class="pdf-paper-toolbar" role="toolbar" aria-label={t("preview.pdf.toolbar")}>
        <ToolbarButton
          label={t("preview.pdf.previousPage")}
          disabled={view.page <= 1}
          onClick={() => viewer?.previousPage()}
        >
          <ChevronUp class="browser-toolbar-icon" />
        </ToolbarButton>
        <span class="pdf-paper-count">
          <span aria-hidden="true">{t("preview.pdf.page", { page: view.page, total: Math.max(1, view.pages) })}</span>
          <span class="sr-only">{t("preview.pdf.pageLabel", { page: view.page, total: Math.max(1, view.pages) })}</span>
        </span>
        <ToolbarButton
          label={t("preview.pdf.nextPage")}
          disabled={view.page >= view.pages}
          onClick={() => viewer?.nextPage()}
        >
          <ChevronDown class="browser-toolbar-icon" />
        </ToolbarButton>
        <span class="pdf-paper-toolbar-gap" />
        <ToolbarButton label={t("preview.pdf.zoomOut")} onClick={() => viewer?.decreaseScale()}>
          <Minus class="browser-toolbar-icon" />
        </ToolbarButton>
        <span class="pdf-paper-count">{t("preview.pdf.zoom", { percent: Math.round(view.scale * 100) })}</span>
        <ToolbarButton label={t("preview.pdf.zoomIn")} onClick={() => viewer?.increaseScale()}>
          <Plus class="browser-toolbar-icon" />
        </ToolbarButton>
        <ToolbarButton
          label={t("preview.pdf.fitWidth")}
          pressed={view.fitWidth}
          onClick={() => {
            if (viewer) viewer.currentScaleValue = FIT_WIDTH;
          }}
        >
          <ArrowLeftRight class="browser-toolbar-icon" />
        </ToolbarButton>
      </div>
      <section class="pdf-paper-stage" aria-label={props.title}>
        <div ref={scroller} class="pdf-paper-scroll" tabindex="0">
          <div ref={pages} class="pdf-paper-pages file-preview-dimmable" />
        </div>
        <Show when={view.failed}>
          <p class="pdf-paper-error">{t("preview.pdf.readFailed")}</p>
        </Show>
      </section>
    </div>
  );
}

function ToolbarButton(props: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <LabelTooltip content={props.label}>
      <LabelTooltipTrigger
        as={Button}
        variant="ghost"
        type="button"
        class="browser-toolbar-button"
        aria-label={props.label}
        aria-pressed={props.pressed === undefined ? undefined : String(props.pressed)}
        disabled={props.disabled}
        onClick={() => props.onClick()}
      >
        {props.children}
      </LabelTooltipTrigger>
    </LabelTooltip>
  );
}
