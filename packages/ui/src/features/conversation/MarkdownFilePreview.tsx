import { Show } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { MarkdownMessageText } from "./MarkdownMessageText";

export interface MarkdownFilePreviewProps {
  body: string;
  agents: AgentProfile[];
  loading?: boolean;
  error?: string | null;
  truncated?: boolean;
  class?: string;
  renderedClass: string;
  statusClass: string;
  truncatedClass: string;
  selectionQuoteId?: string | undefined;
  onSelectAgent: (agentId: string) => void;
  onOpenLink: (url: string) => void;
  onOpenSharedFile: (path: string) => void;
  onOpenWorkspaceFile?: ((path: string) => void) | undefined;
}

const TRUNCATED_AFTER = 1_000_000;
const FRONT_MATTER =
  /^---[ \t]*\r?\n((?:[A-Za-z0-9_-]+[ \t]*:[^\n]*)(?:\r?\n[^\n]*)*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u;

function frontMatterAsCode(body: string): string {
  const match = FRONT_MATTER.exec(body);
  const yaml = match?.[1];
  if (!match || yaml === undefined) return body;
  const longestRun = Math.max(0, ...Array.from(yaml.matchAll(/`+/gu), (run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}yaml\n${yaml}\n${fence}\n\n${body.slice(match[0].length)}`;
}

export function MarkdownFilePreview(props: MarkdownFilePreviewProps) {
  const { t, format } = useText();
  const contentReady = () => props.loading !== true && !props.error;

  return (
    <div class={`markdown-file-preview${props.class ? ` ${props.class}` : ""}`}>
      <Show
        when={contentReady()}
        fallback={
          <pre class={props.statusClass}>
            {props.loading === true ? t("common.loading") : (props.error ?? t("preview.unavailable"))}
          </pre>
        }
      >
        <article class={props.renderedClass} data-selection-file-quote={props.selectionQuoteId}>
          <MarkdownMessageText
            document
            body={frontMatterAsCode(props.body)}
            agents={props.agents}
            attachments={[]}
            citations={[]}
            showCitationFooter={false}
            onSelectAgent={props.onSelectAgent}
            onOpenLink={props.onOpenLink}
            onOpenSharedFile={props.onOpenSharedFile}
            onOpenWorkspaceFile={props.onOpenWorkspaceFile}
          />
        </article>
        <Show when={props.truncated}>
          <p class={props.truncatedClass}>{t("preview.truncated", { limit: format.number(TRUNCATED_AFTER) })}</p>
        </Show>
      </Show>
    </div>
  );
}
