import type { ChatVisualKey } from "@openbot/contracts/chat-visual";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type FilePreview,
  filePreviewKindForFile,
  type WorkspaceDirectory,
  type WorkspaceDirectoryEntry,
} from "@openbot/contracts/ipc";
import {
  ArrowLeft,
  Button,
  buttonVariants,
  Check,
  Code,
  CopyButton,
  Download,
  DropdownMenu,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  LabelTooltip,
  LabelTooltipTrigger,
  Moon,
  Popover,
  SliderField,
  Sun,
  SunDim,
  WrapText,
  X,
} from "@openbot/ui";
import { PanelResizer } from "@openbot/ui/components/PanelResizer";
import { SETTINGS_PANEL_DEFAULT } from "@openbot/ui/components/SettingsPanel";
import type { AgentProfile } from "@openbot/ui/data";
import { ChatVisual } from "@openbot/ui/features/conversation/ChatVisual";
import { type CodeToken, fileCodeLanguage, highlightedCodeLines } from "@openbot/ui/features/conversation/CodeBlock";
import { visibleFileName } from "@openbot/ui/features/conversation/FileReference";
import { MarkdownFilePreview } from "@openbot/ui/features/conversation/MarkdownFilePreview";
import type { QuoteShortcutModifier } from "@openbot/ui/features/conversation/SelectionActions";
import { SpreadsheetFilePreview } from "@openbot/ui/features/conversation/SpreadsheetFilePreview";
import { WordFilePreview } from "@openbot/ui/features/conversation/WordFilePreview";
import { useText } from "@openbot/ui/text";
import { holdFlag } from "@openbot/ui/utils";
import { Dynamic, type JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";

import {
  clampFilePreviewBrightness,
  FILE_PREVIEW_BRIGHTNESS_MAX,
  FILE_PREVIEW_BRIGHTNESS_MIN,
  filePreviewBrightnessStyle,
  filePreviewCanDim,
  isFilePreviewDimmed,
} from "./file-preview-brightness";
import { decodedFileText } from "./file-text";
import { MediaFilePreview } from "./MediaFilePreview";
import { keepFrame, moveFrameInto, pdfBytesFingerprint, takeKeptFrame } from "./pdf-frame-keeper";
import {
  PDF_READING_MODE_LABEL,
  PDF_READING_MODES,
  type PdfFramePositions,
  type PdfPaperReader,
  type PdfPosition,
  type PdfReadingMode,
  pdfReadingMode,
} from "./pdf-reading-mode";

const PANEL_MIN = SETTINGS_PANEL_DEFAULT;
const TEXT_LIMIT = 1_000_000;
const HIGHLIGHT_LIMIT = 200_000;
const HIGHLIGHT_LINE_LIMIT = 5_000;
const BLOB_PREVIEW_KINDS = new Set<FilePreview["previewKind"]>(["image", "pdf", "audio", "video"]);
const PDF_FRAME_POSITION_POLL_MS = 1_000;
const PDF_FRAME_RESTORE_DELAY_MS = 250;
const PDF_FRAME_RESTORE_TRIES = 40;
const PDF_FRAME_SETTLE_DELAY_MS = 600;

type HeaderPopup = "pageColors" | "brightness";

interface FilePreviewPanelProps {
  readWidth: () => number;
  onResizeEnd: (width: number) => void;
  onResetWidth: () => void;
  readWrapLines: () => boolean;
  onWrapLinesChange: (wrap: boolean) => void;
  readBrightness?: (() => number) | undefined;
  onBrightnessChange?: ((brightness: number) => void) | undefined;
  readReadingMode?: (() => PdfReadingMode) | undefined;
  onReadingModeChange?: ((mode: PdfReadingMode) => void) | undefined;
  pdfReader?: PdfPaperReader | undefined;
  pdfPositionKey?: string | undefined;
  readPdfPosition?: ((key: string) => PdfPosition | null) | undefined;
  onPdfPositionChange?: ((key: string, position: PdfPosition) => void) | undefined;
  pdfFramePositions?: PdfFramePositions | undefined;
  preview: FilePreview | null;
  fileKey?: string | undefined;
  directory?: WorkspaceDirectory | null;
  agents: AgentProfile[];
  maxWidth: () => number;
  onWidthChange: (width: number) => void;
  onOpenLink: (url: string) => void;
  onOpenSharedFile: (path: string) => void;
  onOpenWorkspaceFile?: ((path: string) => void) | undefined;
  onOpenWorkspaceFolder?: (path: string) => void;
  onBack?: (() => void) | undefined;
  sourceUrl?: string | null;
  pageUrl?: string | null | undefined;
  pageHtml?: string | null | undefined;
  selectionQuoteId?: string | undefined;
  onPageQuote?: ((text: string) => void) | undefined;
  onPageContext?: ((text: string) => void) | undefined;
  onPageMessage?: ((text: string) => void) | undefined;
  isPageAppShortcut?: ((key: ChatVisualKey) => boolean) | undefined;
  quoteShortcut?: QuoteShortcutModifier | undefined;
  macWindowControls?: boolean | undefined;
  onOpenExternally: () => void;
  allowExternalOpen?: boolean;
  onDownload?: () => void;
  onReveal?: (() => void) | undefined;
  onClose: () => void;
}

export default function FilePreviewPanel(props: FilePreviewPanelProps) {
  const { t, format } = useText();
  const [panelWidth, setPanelWidth] = createSignal(props.readWidth());
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [pdfFrameSource, setPdfFrameSource] = createSignal<PdfFrameSource | null>(null);
  const [revealed, setRevealed] = createSignal(false);
  const [rawSource, setRawSource] = createSignal(false);
  const [wrapLines, setWrapLines] = createSignal(untrack(() => props.readWrapLines()));
  const [brightness, setBrightness] = createSignal(
    untrack(() => clampFilePreviewBrightness(props.readBrightness?.() ?? FILE_PREVIEW_BRIGHTNESS_MAX)),
  );
  const [readingMode, setReadingMode] = createSignal<PdfReadingMode>(untrack(() => props.readReadingMode?.() ?? "off"));
  const [openPopup, setOpenPopup] = createSignal<HeaderPopup | null>(null);
  let savedBrightness = untrack(brightness);
  let currentPreviewUrl: string | null = null;
  let revealFrame: number | undefined;
  const file = () => (props.directory ? null : props.preview);
  const previewKind = () => file()?.previewKind;
  const pageUrl = () => (previewKind() === "text" ? props.pageUrl : null) ?? null;
  const pageHtml = () => (previewKind() === "text" ? props.pageHtml : null) ?? null;
  const hasPage = () => pageHtml() !== null || pageUrl() !== null;
  const tooLarge = () => {
    const preview = file();
    return (
      preview?.previewKind === "none" &&
      preview.size > ATTACHMENT_LIMITS.fileBytes &&
      filePreviewKindForFile(preview.name, preview.mimeType) !== "none"
    );
  };
  const showsSourceText = () =>
    (previewKind() === "text" && (rawSource() || !hasPage())) || (previewKind() === "markdown" && rawSource());
  const canDim = () => filePreviewCanDim({ kind: previewKind(), hasPage: hasPage(), rawSource: rawSource() });
  const title = () => visibleFileName(props.directory?.name ?? props.preview?.name ?? "");
  const source = createMemo(() => {
    const preview = file();
    if (!preview?.bytes || (preview.previewKind !== "text" && preview.previewKind !== "markdown")) return "";
    return decodedFileText(preview.bytes);
  });
  const text = createMemo(() => ({ value: source().slice(0, TEXT_LIMIT), truncated: source().length > TEXT_LIMIT }));
  const openEntry = (entry: WorkspaceDirectoryEntry) => {
    if (entry.kind === "directory") props.onOpenWorkspaceFolder?.(entry.path);
    else props.onOpenWorkspaceFile?.(entry.path);
  };

  createEffect(
    () => panelWidth(),
    (width) => {
      props.onWidthChange(width);
    },
  );
  const shownFile = createMemo(() => props.fileKey ?? file());
  createEffect(shownFile, () => {
    setRawSource(false);
    showPopup(null);
  });
  createEffect(
    () => ({ preview: file(), sourceUrl: props.sourceUrl, frameKey: props.pdfPositionKey }),
    ({ preview, sourceUrl, frameKey }) => {
      if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
      currentPreviewUrl = null;
      setPdfFrameSource(null);
      if (!preview) {
        setPreviewUrl(null);
        return;
      }
      if (sourceUrl && BLOB_PREVIEW_KINDS.has(preview.previewKind)) {
        setPreviewUrl(sourceUrl);
        if (preview.previewKind === "pdf") setPdfFrameSource({ src: sourceUrl, key: frameKey, identity: sourceUrl });
        return;
      }
      if (!preview.bytes || !BLOB_PREVIEW_KINDS.has(preview.previewKind)) {
        setPreviewUrl(null);
        return;
      }
      // Fork (docs/fork/FEATURES.md #124): a framed blob: has the app's origin, so a PDF is only ever framed as a PDF.
      const blob = new Blob([new Uint8Array(preview.bytes).buffer], {
        type: preview.previewKind === "pdf" ? "application/pdf" : preview.mimeType,
      });
      if (preview.previewKind === "image") {
        let current = true;
        setPreviewUrl(null);
        const reader = new FileReader();
        reader.onload = () => {
          if (current && typeof reader.result === "string") setPreviewUrl(reader.result);
        };
        reader.readAsDataURL(blob);
        return () => {
          current = false;
          reader.abort();
        };
      }
      const url = URL.createObjectURL(blob);
      currentPreviewUrl = url;
      setPreviewUrl(url);
      if (preview.previewKind === "pdf")
        setPdfFrameSource({ src: url, key: frameKey, identity: pdfBytesFingerprint(preview.bytes) });
    },
  );
  onSettled(() => () => {
    if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
    if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
  });

  let panel!: HTMLElement;
  onSettled(() => {
    const conversation = panel.closest(".conversation-panel");
    return conversation ? holdFlag(conversation, "file-preview-panel") : undefined;
  });

  const revealPanel = (element: HTMLElement) => {
    panel = element;
    revealFrame = requestAnimationFrame(() => {
      revealFrame = requestAnimationFrame(() => {
        setRevealed(true);
      });
    });
  };

  const toggleWrapLines = () => {
    const wrap = !wrapLines();
    setWrapLines(wrap);
    props.onWrapLinesChange(wrap);
  };

  const saveBrightness = (value: number) => {
    const next = clampFilePreviewBrightness(value);
    setBrightness(next);
    if (next === savedBrightness) return;
    savedBrightness = next;
    props.onBrightnessChange?.(next);
  };
  const chooseReadingMode = (mode: PdfReadingMode) => {
    setReadingMode(mode);
    props.onReadingModeChange?.(mode);
  };
  const pdfReader = () => (previewKind() === "pdf" ? props.pdfReader : undefined);
  const paperMode = () => {
    const mode = readingMode();
    return mode === "off" ? null : mode;
  };

  const shownPopup = () => {
    const popup = openPopup();
    if (popup === "pageColors" && !pdfReader()) return null;
    if (popup === "brightness" && !canDim()) return null;
    return popup;
  };
  const showPopup = (next: HeaderPopup | null) => {
    if (openPopup() === "brightness" && next !== "brightness") saveBrightness(brightness());
    setOpenPopup(next);
  };
  const popupOpenChange = (popup: HeaderPopup) => (open: boolean) => {
    if (open) showPopup(popup);
    else if (openPopup() === popup) showPopup(null);
  };
  const popupTriggers: Partial<Record<HeaderPopup, HTMLElement>> = {};
  const returnFocusAfterClose = (trigger: HTMLElement | undefined) => {
    const focusAtClose = document.activeElement;
    if (focusAtClose !== null && panel.contains(focusAtClose)) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const focusLost = active === null || active === document.body || !active.isConnected || active === focusAtClose;
        if (trigger?.isConnected && focusLost) trigger.focus();
      }),
    );
  };
  createEffect(shownPopup, (popup) => {
    if (!popup) return;
    const closeOnlyPopup = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      showPopup(null);
      returnFocusAfterClose(popupTriggers[popup]);
    };
    document.addEventListener("keydown", closeOnlyPopup, true);
    return () => document.removeEventListener("keydown", closeOnlyPopup, true);
  });
  onSettled(() => () => saveBrightness(untrack(brightness)));

  const resizeDefaultPanel = () => {
    setPanelWidth(Math.round(Math.min(props.maxWidth(), Math.max(PANEL_MIN, props.readWidth()))));
  };

  return (
    <aside
      ref={revealPanel}
      id="file-preview-panel"
      class="browser-panel file-preview-panel t-panel-slide"
      data-open={revealed() ? "true" : "false"}
      aria-label={t("preview.panel.label")}
    >
      <PanelResizer
        class="right-panel-resizer"
        label={t("preview.panel.resize")}
        controls="file-preview-panel"
        direction="right"
        value={panelWidth()}
        defaultValue={PANEL_MIN}
        min={PANEL_MIN}
        max={props.maxWidth}
        onResize={setPanelWidth}
        onResizeEnd={props.onResizeEnd}
        onParentResize={resizeDefaultPanel}
        onReset={() => {
          props.onResetWidth();
          setPanelWidth(props.readWidth());
        }}
      />
      <header class="file-preview-header">
        <Show when={props.onBack}>
          {(back) => (
            <HeaderButton label={t("preview.panel.back")} onClick={() => back()()}>
              <ArrowLeft class="browser-toolbar-icon" />
            </HeaderButton>
          )}
        </Show>
        <Show when={props.directory} fallback={<File class="file-preview-file-icon" />}>
          <Folder class="file-preview-file-icon" />
        </Show>
        <h2 title={props.directory?.path ?? title()}>{title()}</h2>
        <Show when={previewKind() === "markdown"}>
          <HeaderButton
            label={t("preview.panel.rawMarkdown")}
            pressed={rawSource()}
            onClick={() => setRawSource((raw) => !raw)}
          >
            <Code class="browser-toolbar-icon" />
          </HeaderButton>
        </Show>
        <Show when={hasPage()}>
          <HeaderButton
            label={t("preview.panel.rawHtml")}
            pressed={rawSource()}
            onClick={() => setRawSource((raw) => !raw)}
          >
            <Code class="browser-toolbar-icon" />
          </HeaderButton>
        </Show>
        <Show when={showsSourceText()}>
          <HeaderButton label={t("preview.panel.wrapLines")} pressed={wrapLines()} onClick={toggleWrapLines}>
            <WrapText class="browser-toolbar-icon" />
          </HeaderButton>
        </Show>
        <Show when={source()}>
          {(value) => (
            <LabelTooltip content={t("preview.panel.copy")}>
              <LabelTooltipTrigger
                as={CopyButton}
                class="browser-toolbar-button file-preview-copy"
                value={value()}
                label={t("preview.panel.copy")}
                iconOnly
              />
            </LabelTooltip>
          )}
        </Show>
        <Show when={pdfReader()}>
          <PageColorsControl
            mode={readingMode()}
            open={shownPopup() === "pageColors"}
            onOpenChange={popupOpenChange("pageColors")}
            triggerRef={(element) => {
              popupTriggers.pageColors = element;
            }}
            onChange={chooseReadingMode}
          />
        </Show>
        <Show when={canDim()}>
          <BrightnessControl
            value={brightness()}
            open={shownPopup() === "brightness"}
            onOpenChange={popupOpenChange("brightness")}
            triggerRef={(element) => {
              popupTriggers.brightness = element;
            }}
            onChange={(value) => setBrightness(clampFilePreviewBrightness(value))}
            onChangeEnd={saveBrightness}
          />
        </Show>
        <Show when={file() && props.allowExternalOpen !== false}>
          <HeaderButton label={t("preview.panel.openExternally")} onClick={props.onOpenExternally}>
            <ExternalLink class="browser-toolbar-icon" />
          </HeaderButton>
        </Show>
        <Show when={file() && props.onDownload}>
          {(download) => (
            <HeaderButton label={t("preview.panel.download")} onClick={() => download()()}>
              <Download class="browser-toolbar-icon" />
            </HeaderButton>
          )}
        </Show>
        <Show when={file() && props.onReveal}>
          {(reveal) => (
            <HeaderButton label={t("preview.panel.reveal")} onClick={() => reveal()()}>
              <FolderOpen class="browser-toolbar-icon" />
            </HeaderButton>
          )}
        </Show>
        <HeaderButton
          label={t("preview.panel.close")}
          class="side-panel-pane-close"
          data-cuelume-tap="close"
          onClick={props.onClose}
        >
          <X class="browser-toolbar-icon" />
        </HeaderButton>
      </header>
      <div
        class="file-preview-content"
        data-dimmed={canDim() && isFilePreviewDimmed(brightness()) ? "" : undefined}
        style={filePreviewBrightnessStyle(brightness())}
      >
        <Show when={props.directory}>
          {(directory) => (
            <Show
              when={directory().entries.length > 0}
              fallback={<p class="file-preview-folder-empty">{t("preview.folder.empty")}</p>}
            >
              <ul class="file-preview-folder" aria-label={directory().name}>
                <For each={directory().entries}>
                  {(entry) => (
                    <li>
                      <Button
                        variant="ghost"
                        type="button"
                        class="file-preview-folder-entry"
                        title={entry.path}
                        onClick={() => openEntry(entry)}
                      >
                        <Show when={entry.kind === "directory"} fallback={<File class="file-preview-file-icon" />}>
                          <Folder class="file-preview-file-icon" />
                        </Show>
                        <span class="file-preview-folder-name">{entry.name}</span>
                        <span class="file-preview-folder-meta">
                          {entry.kind === "file" ? format.fileSize(entry.size) : ""}
                        </span>
                        <span class="file-preview-folder-meta">
                          {entry.modifiedAt > 0 ? format.date(entry.modifiedAt, { dateStyle: "medium" }) : ""}
                        </span>
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={directory().truncated}>
                <p class="file-preview-truncated">
                  {t("preview.folder.truncated", { limit: format.number(directory().entries.length) })}
                </p>
              </Show>
            </Show>
          )}
        </Show>
        <Show when={previewKind() === "markdown" && !rawSource()}>
          <MarkdownFilePreview
            class="file-preview-markdown"
            renderedClass="message-markdown"
            statusClass="file-preview-markdown-status"
            truncatedClass="file-preview-truncated"
            selectionQuoteId={props.selectionQuoteId}
            body={text().value}
            truncated={text().truncated}
            agents={props.agents}
            onSelectAgent={() => undefined}
            onOpenLink={props.onOpenLink}
            onOpenSharedFile={props.onOpenSharedFile}
            onOpenWorkspaceFile={props.onOpenWorkspaceFile}
          />
        </Show>
        <Show when={!rawSource() && hasPage()}>
          <ChatVisual
            fill
            src={pageUrl() ?? undefined}
            html={pageHtml() ?? undefined}
            title={title()}
            onOpenLink={props.onOpenLink}
            onQuote={props.onPageQuote}
            onContext={props.onPageContext}
            onMessage={props.onPageMessage}
            isAppShortcut={props.isPageAppShortcut}
            quoteShortcut={props.quoteShortcut}
            macWindowControls={props.macWindowControls}
          />
        </Show>
        <Show when={showsSourceText()}>
          <FileSourceText
            name={title()}
            text={text().value}
            wrap={wrapLines()}
            selectionQuoteId={props.selectionQuoteId}
          />
          <Show when={text().truncated}>
            <p class="file-preview-truncated">{t("preview.truncated", { limit: format.number(TEXT_LIMIT) })}</p>
          </Show>
        </Show>
        <Show when={previewKind() === "image" && previewUrl()}>
          <div class="file-preview-image-wrap">
            <img class="file-preview-image" src={previewUrl() ?? ""} alt={title()} />
          </div>
        </Show>
        <Show when={previewKind() === "pdf" && previewUrl()}>
          <Show
            when={pdfReader() && paperMode()}
            fallback={
              <Show when={pdfFrameSource()}>
                {(source) => <PdfFrame source={source()} title={title()} positions={props.pdfFramePositions} />}
              </Show>
            }
          >
            {(mode) => (
              <Dynamic
                component={pdfReader()}
                bytes={file()?.bytes ?? null}
                url={props.sourceUrl ?? null}
                title={title()}
                mode={mode()}
                onOpenLink={props.onOpenLink}
                positionKey={props.pdfPositionKey ?? null}
                readPosition={props.readPdfPosition}
                onPositionChange={props.onPdfPositionChange}
              />
            )}
          </Show>
        </Show>
        <Show when={previewUrl()}>
          <MediaFilePreview
            kind={previewKind() === "audio" ? "audio" : previewKind() === "video" ? "video" : null}
            src={previewUrl() ?? undefined}
            name={title()}
            class={previewKind() === "audio" ? "file-preview-audio" : "file-preview-video"}
          />
        </Show>
        <Show when={previewKind() === "spreadsheet"}>
          <SpreadsheetFilePreview class="file-preview-spreadsheet" bytes={file()?.bytes ?? null} />
        </Show>
        <Show when={previewKind() === "document"}>
          <WordFilePreview class="file-preview-markdown" bytes={file()?.bytes ?? null} />
        </Show>
        <Show when={previewKind() === "none"}>
          <div class="file-preview-unsupported">
            <File />
            <strong>{tooLarge() ? t("preview.tooLarge.title") : t("preview.unsupported.title")}</strong>
            <Show when={props.allowExternalOpen !== false}>
              <span>{tooLarge() ? t("preview.tooLarge.description") : t("preview.unsupported.description")}</span>
              <Button variant="outline" type="button" onClick={props.onOpenExternally}>
                {t("preview.unsupported.openExternally")}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
    </aside>
  );
}

interface PdfFrameSource {
  src: string;
  key: string | undefined;
  identity: string;
}

function PdfFrame(props: { source: PdfFrameSource; title: string; positions: PdfFramePositions | undefined }) {
  let host!: HTMLDivElement;
  createEffect(
    () => props.source,
    ({ src, key, identity }) => {
      const kept = key && identity ? takeKeptFrame(key, identity) : null;
      const frame = kept ?? document.createElement("iframe");
      frame.className = "file-preview-pdf";
      frame.title = untrack(() => props.title);
      if (!kept) frame.src = src;
      moveFrameInto(host, frame);
      const positions = untrack(() => props.positions);
      const frameUrl = frame.getAttribute("src") ?? src;
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const track = () => {
        timer = setTimeout(async () => {
          if (!active || !positions || !key) return;
          const position = await positions.read(frameUrl).catch(() => null);
          if (active && position) positions.save(key, position);
          if (active) track();
        }, PDF_FRAME_POSITION_POLL_MS);
      };
      const restore = async (tries: number, settle: boolean) => {
        if (!active || !positions || !key) return;
        const position = positions.load(key);
        const restored = position ? await positions.restore(frameUrl, position).catch(() => false) : true;
        if (!active) return;
        if (restored && position && settle) timer = setTimeout(() => void restore(0, false), PDF_FRAME_SETTLE_DELAY_MS);
        else if (restored || tries <= 0) track();
        else timer = setTimeout(() => void restore(tries - 1, settle), PDF_FRAME_RESTORE_DELAY_MS);
      };
      if (positions && key) {
        if (kept) track();
        else void restore(PDF_FRAME_RESTORE_TRIES, true);
      }
      return () => {
        active = false;
        clearTimeout(timer);
        if (key && identity) keepFrame(key, identity, frame);
        else frame.remove();
      };
    },
  );
  createEffect(
    () => props.title,
    (title) => {
      const frame = host.querySelector("iframe");
      if (frame) frame.title = title;
    },
  );
  return <div ref={host} class="file-preview-pdf-host" />;
}

function HeaderButton(props: {
  label: string;
  class?: string;
  pressed?: boolean;
  onClick: () => void;
  "data-cuelume-tap"?: string;
  children: JSX.Element;
}) {
  const pressed = () => (props.pressed === undefined ? undefined : String(props.pressed));
  return (
    <LabelTooltip content={props.label}>
      <LabelTooltipTrigger
        as={Button}
        variant="ghost"
        type="button"
        class={["browser-toolbar-button", props.class]}
        aria-label={props.label}
        aria-pressed={pressed()}
        data-cuelume-tap={props["data-cuelume-tap"]}
        onClick={() => props.onClick()}
      >
        {props.children}
      </LabelTooltipTrigger>
    </LabelTooltip>
  );
}

function PageColorsControl(props: {
  mode: PdfReadingMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: (element: HTMLElement) => void;
  onChange: (mode: PdfReadingMode) => void;
}) {
  const { t } = useText();
  const label = () => t("preview.reading.label");
  return (
    <DropdownMenu.Root open={props.open} onOpenChange={props.onOpenChange} placement="bottom-end" gutter={6}>
      <LabelTooltip content={label()}>
        <LabelTooltipTrigger
          as={DropdownMenu.Trigger}
          ref={props.triggerRef}
          class={[buttonVariants({ variant: "ghost" }), "browser-toolbar-button file-preview-view-trigger"]}
          aria-label={label()}
          data-active={props.mode === "off" ? undefined : ""}
        >
          <Moon class="browser-toolbar-icon" />
        </LabelTooltipTrigger>
      </LabelTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content aria-label={label()}>
          <DropdownMenu.RadioGroup
            value={props.mode}
            onChange={(value: string) => props.onChange(pdfReadingMode(value))}
          >
            <For each={PDF_READING_MODES}>
              {(mode) => (
                <DropdownMenu.RadioItem value={mode} closeOnSelect>
                  <span class="ui-menu-check" data-checked={props.mode === mode ? "" : undefined} aria-hidden="true">
                    <Show when={props.mode === mode}>
                      <Check />
                    </Show>
                  </span>
                  <span>{t(PDF_READING_MODE_LABEL[mode])}</span>
                </DropdownMenu.RadioItem>
              )}
            </For>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function BrightnessControl(props: {
  value: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: (element: HTMLElement) => void;
  onChange: (value: number) => void;
  onChangeEnd: (value: number) => void;
}) {
  const { t, format } = useText();
  const dimmed = () => isFilePreviewDimmed(props.value);
  const label = () => t("preview.panel.brightness");
  let content: HTMLElement | undefined;
  const focusSlider = () => content?.querySelector<HTMLElement>('[role="slider"]')?.focus();

  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      const frame = requestAnimationFrame(focusSlider);
      return () => cancelAnimationFrame(frame);
    },
  );

  const reset = () => {
    props.onChangeEnd(FILE_PREVIEW_BRIGHTNESS_MAX);
    focusSlider();
  };

  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange} placement="bottom-end" gutter={6}>
      <LabelTooltip content={label()}>
        <LabelTooltipTrigger
          as={Popover.Trigger}
          ref={props.triggerRef}
          class={[buttonVariants({ variant: "ghost" }), "browser-toolbar-button file-preview-view-trigger"]}
          aria-label={label()}
          data-active={dimmed() ? "" : undefined}
        >
          <Show when={dimmed()} fallback={<Sun class="browser-toolbar-icon" />}>
            <SunDim class="browser-toolbar-icon" />
          </Show>
        </LabelTooltipTrigger>
      </LabelTooltip>
      <Popover.Portal>
        <Popover.Content
          ref={(element: HTMLElement) => {
            content = element;
          }}
          class="ui-popover-menu-surface file-preview-brightness"
        >
          <SliderField
            label={label()}
            description={t("preview.panel.brightnessHint")}
            value={props.value}
            minValue={FILE_PREVIEW_BRIGHTNESS_MIN}
            maxValue={FILE_PREVIEW_BRIGHTNESS_MAX}
            formatValue={(value) => format.percent(value / FILE_PREVIEW_BRIGHTNESS_MAX)}
            onChange={props.onChange}
            onChangeEnd={props.onChangeEnd}
          />
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="file-preview-brightness-reset"
            disabled={!dimmed()}
            onClick={reset}
          >
            {t("preview.panel.brightnessReset")}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FileSourceText(props: { name: string; text: string; wrap: boolean; selectionQuoteId?: string | undefined }) {
  const [tokens, setTokens] = createSignal<CodeToken[] | null>(null);
  let highlightRun = 0;

  createEffect(
    () => ({ language: fileCodeLanguage(props.name), text: props.text }),
    ({ language, text }) => {
      const run = ++highlightRun;
      setTokens(null);
      if (language === "plain" || text.length > HIGHLIGHT_LIMIT) return;
      if (text.split("\n").some((line) => line.length > HIGHLIGHT_LINE_LIMIT)) return;
      void highlightedCodeLines(text, language).then((lines) => {
        if (run !== highlightRun || !lines) return;
        setTokens(lines.flatMap((line, index) => (index === 0 ? line : [{ text: "\n" }, ...line])));
      });
    },
  );
  onCleanup(() => {
    highlightRun += 1;
  });

  return (
    <pre
      class={{ "file-preview-text": true, "file-preview-text-wrap": props.wrap }}
      data-selection-file-quote={props.selectionQuoteId}
      data-selection-file-lines={props.selectionQuoteId ? "true" : undefined}
    >
      <Show when={tokens()} fallback={props.text}>
        {(highlighted) => (
          <For each={highlighted()}>{(token) => <span data-code-token={token.type}>{token.text}</span>}</For>
        )}
      </Show>
    </pre>
  );
}
