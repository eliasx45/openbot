import { Bubble, BubbleContent, type BubbleVariant } from "@openbot/ui";
import type { AgentMessage } from "@openbot/ui/data";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENTS, STORY_ATTACHMENTS, STORY_REPLY_QUOTE_BODY } from "./fixtures";

const message: AgentMessage = {
  id: "message-body-1",
  author: "agent",
  body: "Here is the latest brief. You can also review https://openbot.run/docs or ask @Research.",
  time: "10:00",
  status: "Ready to review",
  attachments: STORY_ATTACHMENTS,
};

const args: Parameters<typeof MessageBody>[0] = {
  message,
  referencedMessage: undefined,
  agents: STORY_AGENTS,
  onSelectAgent: fn(),
  onOpenLink: fn(),
  onPreview: fn(),
  onAttachmentAction: fn(),
};

const meta = {
  title: "Conversation/MessageBody",
  component: MessageBody,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof MessageBody>;

export default meta;
type Story = StoryObj<typeof meta>;

function MessageBodySurface(props: {
  args: Parameters<typeof MessageBody>[0];
  author?: "assistant" | "user";
  variant?: BubbleVariant;
  width: string;
}) {
  const author = () => props.author ?? "assistant";
  return (
    <Bubble
      align={author() === "user" ? "end" : "start"}
      variant={props.variant ?? (author() === "user" ? "default" : "muted")}
      data-author={author()}
      style={{ width: props.width, "max-width": "calc(100vw - 32px)" }}
    >
      <BubbleContent>
        <MessageBody {...props.args} />
      </BubbleContent>
    </Bubble>
  );
}

export const RichMessage: Story = {};

export const AuthError: Story = {
  args: {
    message: {
      ...message,
      id: "message-auth-error",
      kind: "error",
      status: "Sign in required",
      body: "Authentication failed. Check your account or server connection, then try again.",
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} width="420px" />,
};

export const WithReplyContext: Story = {
  args: {
    referencedMessage: {
      id: "message-reference",
      author: "you",
      body: "Can you make this more concise?",
      time: "09:55",
    },
  },
};

const reply: AgentMessage = {
  id: "message-reply",
  author: "you",
  body: "Approved. Renew it today and tell me the new expiry date.",
  time: "10:00",
  replyToMessageId: "message-reference",
  attachments: [],
};

const quoted: AgentMessage = {
  id: "message-reference",
  author: "agent",
  body: "Without a renewed certificate, macOS rejects the update on Friday. I need your approval to buy the renewal.",
  time: "09:55",
};

export const ReplyOpensOriginal: Story = {
  args: { message: reply, referencedMessage: quoted, onOpenReference: fn() },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} author="user" width="360px" />,
};

export const ReplyLoadingOriginal: Story = {
  args: { message: reply, referencedMessage: quoted, onOpenReference: fn(), referenceState: "loading" },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} author="user" width="360px" />,
};

export const ReplyOriginalUnavailable: Story = {
  args: { message: reply, referenceState: "unavailable" },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} author="user" width="360px" />,
};

const markdownQuoted: AgentMessage = {
  id: "message-reference",
  author: "agent",
  body: STORY_REPLY_QUOTE_BODY,
  time: "09:55",
};

export const ReplyMarkdownOriginal: Story = {
  args: { message: reply, referencedMessage: markdownQuoted, onOpenReference: fn() },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} author="user" width="360px" />,
};

export const ReplyMarkdownOpenFence: Story = {
  args: {
    message: reply,
    referencedMessage: {
      ...markdownQuoted,
      body: ["Run these before the tag:", "", "```bash", "bun run check", "bun run test:changed", "bun run lint"].join(
        "\n",
      ),
    },
    onOpenReference: fn(),
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} author="user" width="360px" />,
};

export const WithSelectedTextInstruction: Story = {
  args: {
    message: {
      ...message,
      id: "message-selected-text-instruction",
      author: "you",
      body: "Make this more concise.\n\n> The selected sentence keeps all of the original context.",
      replyToMessageId: "message-reference",
      status: undefined,
      attachments: [],
    },
    referencedMessage: {
      id: "message-reference",
      author: "agent",
      body: "A longer agent response containing the selected sentence and supporting context.",
      time: "09:55",
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} author="user" width="360px" />,
};

export const AttachmentOnly: Story = {
  args: {
    message: { ...message, body: "", status: undefined },
  },
};

export const Markdown: Story = {
  args: {
    message: {
      ...message,
      id: "message-markdown",
      body: [
        "## Recommendation",
        "",
        "Use **Kobalte** with *Solid UI* and `@kobalte/core`.",
        "",
        "- Accessible controls",
        "  - Keyboard support",
        "- [x] Tested",
        "",
        "> Keep the public API small.",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} width="460px" />,
};

export const WorkspaceFileLinks: Story = {
  args: {
    message: {
      ...message,
      id: "message-workspace-file-links",
      body: [
        "Pliki:",
        "",
        "- [page.tsx](/Users/test/OpenBot/Agents/builder/app/page.tsx)",
        "- [globals.css](/Users/test/OpenBot/Agents/builder/app/globals.css)",
        "",
        "Gotowe: [otwórz tablicę Lutra w HTML](< lutra-brand-board.html >)",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
    onOpenWorkspaceFile: fn(),
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} width="620px" />,
};

export const CodeBlock: Story = {
  args: {
    message: {
      ...message,
      id: "message-code-block",
      body: [
        "The helper is ready:",
        "",
        "```ts churn.ts",
        "export async function churnBatch() {",
        '  const flavor = await getFlavor("pistachio");',
        "  const base = await dairy.fetch({ flavor });",
        '  await freezer.store(base, { temp: "-14C" });',
        "  return base.gallons;",
        "}",
        "```",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

export const UnknownConstructorLanguage: Story = {
  args: {
    message: {
      ...message,
      id: "message-unknown-constructor-language",
      body: ["Before the code.", "", "```constructor", "const total = 42;", "```", "", "After the code."].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

export const UnknownPrototypeLanguage: Story = {
  args: {
    message: {
      ...message,
      id: "message-unknown-prototype-language",
      body: ["Before the code.", "", "```__proto__", "const fallback = 7;", "```", "", "After the code."].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

export const UnknownOrdinaryLanguage: Story = {
  args: {
    message: {
      ...message,
      id: "message-unknown-ordinary-language",
      body: ["Before the code.", "", "```mylang", "const ordinary = 3;", "```", "", "After the code."].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

export const StreamingCodeBlock: Story = {
  args: {
    message: {
      ...message,
      id: "message-streaming-code-block",
      body: [
        "```tsx AgentCard.tsx",
        "export function AgentCard(props: { name: string }) {",
        "  return <strong>{props.name}</strong>;",
      ].join("\n"),
      streaming: true,
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

export const DataTable: Story = {
  args: {
    message: {
      ...message,
      id: "message-data-table",
      body: [
        "| Model | Context | $/1M in |",
        "| --- | --- | ---: |",
        "| gpt-4o | 128k | $5.00 |",
        "| claude-3.5 | 200k | $3.00 |",
        "| llama-3.1 | 128k | $0.90 |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

export const DataTableMath: Story = {
  args: {
    message: {
      ...message,
      id: "message-data-table-math",
      body: [
        "| Matrix | Value |",
        "|---|---|",
        String.raw`| $A$ (std) | $\begin{pmatrix}1&-2&-1\\-1&1&0\\-1&0&-1\end{pmatrix}$ |`,
        String.raw`| $P$ (cols = $v_1, v_2, v_3$) | $\begin{bmatrix}1&0&2\\1&0&1\\0&1&-3\end{bmatrix}$ |`,
        String.raw`| Unit ball | $\{v \in \mathbb{R}^3 : \|v\| \le 1\}$ and $$\frac{1}{\sqrt{2}}\begin{pmatrix}1&1\\1&-1\end{pmatrix}$$ |`,
        "| Prose | a \\\\ b, \\*not bold\\* costs $5.00, `a\\|b` |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="560px" />,
};

export const MathInEmphasis: Story = {
  args: {
    message: {
      ...message,
      id: "message-math-in-emphasis",
      body: [
        String.raw`**The set $\{x \mid x^* > 0\}$ is open** and *the product $a*b$ is defined*.`,
        "",
        String.raw`- *Ratio \(x*y\) per unit*`,
        "- ~~old bound $a~~b$ removed~~",
        "",
        "| Term | Note |",
        "|---|---|",
        "| Adjoint | **uses $A^{**}$ twice** |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="560px" />,
};

export const MathFence: Story = {
  args: {
    message: {
      ...message,
      id: "message-math-fence",
      body: [
        "The area under the curve:",
        "",
        "```math",
        String.raw`\int_0^1 x^2 \,dx = \frac{1}{3}`,
        "```",
        "",
        "So the mean value is one third.",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="560px" />,
};

export const DataTableNarrow: Story = {
  args: {
    message: {
      ...message,
      id: "message-data-table-narrow",
      body: [
        "| Fixture | Market odds H/D/A | Implied H/D/A | Scenario | Pick |",
        "| --- | ---: | ---: | ---: | --- |",
        "| Ipswich–Liverpool | 5.25 / 4.60 / 1.57 | 18% / 21% / 61% | 20% / 22% / 58% | Liverpool win |",
        "| Newcastle–Bournemouth | 2.20 / 3.70 / 3.00 | 43% / 26% / 32% | 45% / 27% / 28% | Newcastle, cautiously |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="320px" />,
};

export const DataTableLongText: Story = {
  args: {
    message: {
      ...message,
      id: "message-data-table-long-text",
      body: [
        "| Step | Owner | Notes | Reference |",
        "| --- | --- | --- | --- |",
        "| Migrate | Research | Copy every workspace to the new layout, then confirm that each conversation still opens with its attachments and its full history. | https://openbot.run/docs/guides/workspaces/migrating-an-existing-workspace-to-the-new-layout |",
        "| Verify | Review | Run the checks on a clean profile and compare the results with the previous release before you approve the change. | `bun run test:desktop -- src/renderer/src/features/conversation/MessageRendering.test.tsx` |",
        "| Ship | Release | Write the release notes. | `OPENBOT_RELEASE_CHANNEL_OVERRIDE_FOR_INTERNAL_TESTING_ONLY` |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="720px" />,
};

export const ComparisonTable: Story = {
  args: {
    message: {
      ...message,
      id: "message-comparison-table",
      body: [
        "| Feature | Personal | Enterprise |",
        "| --- | --- | --- |",
        "| Unlimited projects | ✓ | ✓ |",
        "| All components | ✓ | ✓ |",
        "| Team-wide usage | — | ✓ |",
        "| Priority support | — | ✓ |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

export const ComparisonTableNarrow: Story = {
  args: {
    message: {
      ...message,
      id: "message-comparison-table-narrow",
      body: [
        "| Feature | Free | Personal | Business | Enterprise |",
        "| --- | --- | --- | --- | --- |",
        "| Unlimited projects | — | ✓ | ✓ | ✓ |",
        "| Team-wide usage | — | — | ✓ | ✓ |",
        "| Priority support | — | — | — | ✓ |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="320px" />,
};

export const CompletedAnswerReveal: Story = {
  args: {
    message: {
      ...message,
      id: "completed-answer-reveal",
      body: "## Findings\n\nThe final answer is ready with **formatted text**.\n\n- Review the changes\n- Run the checks",
      animate: true,
      streaming: false,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" rx="32" fill="#1f5c3a"/><path d="M60 170 L170 60 L185 75 L75 185 Z" fill="#d8dde3"/><rect x="40" y="168" width="40" height="22" rx="6" transform="rotate(-45 60 179)" fill="#8a5a2b"/></svg>`;
const BANNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 200"><rect width="480" height="200" fill="#f6a62f"/><circle cx="100" cy="100" r="60" fill="#12141a"/><rect x="190" y="80" width="240" height="40" rx="8" fill="#12141a"/></svg>`;
const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;
const NAMED_IMAGES: Record<string, string> = {
  "/data/OpenBot/Shared/demo/maczeciarz/logo.svg": svgDataUrl(LOGO_SVG),
  "/data/OpenBot/Shared/demo/maczeciarz/banner.svg": svgDataUrl(BANNER_SVG),
};
const loadNamedImage: Parameters<typeof MessageBody>[0]["loadImageFile"] = (file) =>
  Promise.resolve(NAMED_IMAGES[file.path] ?? null);

export const NamedImageFile: Story = {
  args: {
    message: {
      ...message,
      id: "named-image-file",
      body: "Done. Logo delivered to Boss:\n\n- `/data/OpenBot/Shared/demo/maczeciarz/logo.svg` — machete icon and wordmark.",
      attachments: [],
    },
    onOpenSharedFile: fn(),
    loadImageFile: loadNamedImage,
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};

export const NamedImageFiles: Story = {
  args: {
    message: {
      ...message,
      id: "named-image-files",
      body: "Status: done\nResult: logo and banner are in the shared folder.\nEvidence: `/data/OpenBot/Shared/demo/maczeciarz/logo.svg`, `/data/OpenBot/Shared/demo/maczeciarz/banner.svg`, `/data/OpenBot/Shared/demo/maczeciarz/missing.png`",
      attachments: [],
    },
    onOpenSharedFile: fn(),
    loadImageFile: loadNamedImage,
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
};
