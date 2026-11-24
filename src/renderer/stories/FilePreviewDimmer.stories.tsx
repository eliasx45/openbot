import type { ConversationMessage, FilePreview } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { App } from "../src/App";
import FilePreviewPanel from "../src/features/conversation/FilePreviewPanel";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { OpenBotPlayground } from "../src/preview/OpenBotPlayground";
import worksheetUrl from "./assets/algebra-worksheet.pdf?inline";
import { STORY_AGENTS, STORY_SNAPSHOTS } from "./fixtures";

const WORKSHEET_NAME = "algebra-worksheet.pdf";
const WHITEBOARD_NAME = "whiteboard.svg";
const WORKSHEET_PATH = `/mock/OpenBot/Agents/chief/${WORKSHEET_NAME}`;

function dataUrlBytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(",") + 1));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const WORKSHEET_BYTES = dataUrlBytes(worksheetUrl);

const WORKSHEET: FilePreview = {
  name: WORKSHEET_NAME,
  size: WORKSHEET_BYTES.length,
  mimeType: "application/pdf",
  previewKind: "pdf",
  bytes: WORKSHEET_BYTES,
};

const WHITEBOARD_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">',
  '<rect width="1200" height="800" fill="#ffffff"/>',
  '<text x="60" y="90" font-family="Helvetica, Arial, sans-serif" font-size="48" font-weight="700" fill="#1d2a6b">Change of basis</text>',
  '<path d="M140 640 L140 200 M140 640 L620 640" stroke="#222222" stroke-width="5" fill="none"/>',
  '<path d="M140 640 L520 300" stroke="#d62828" stroke-width="8"/>',
  '<path d="M140 640 L560 560" stroke="#1565c0" stroke-width="8"/>',
  '<text x="530" y="290" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#d62828">f(v1)</text>',
  '<text x="575" y="560" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#1565c0">f(v2)</text>',
  '<rect x="760" y="160" width="340" height="220" rx="10" fill="#ffe066"/>',
  '<text x="790" y="230" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#3d3200">P = [v1 v2]</text>',
  '<text x="790" y="290" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#3d3200">A\u2032 = P\u207b\u00b9 A P</text>',
  '<rect x="760" y="440" width="340" height="200" rx="10" fill="#ffb3c6"/>',
  '<text x="790" y="510" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#4a0f20">Check: det P \u2260 0</text>',
  "</svg>",
].join("");

const WHITEBOARD_BYTES = new TextEncoder().encode(WHITEBOARD_SVG);

const WHITEBOARD: FilePreview = {
  name: WHITEBOARD_NAME,
  size: WHITEBOARD_BYTES.length,
  mimeType: "image/svg+xml",
  previewKind: "image",
  bytes: WHITEBOARD_BYTES,
};

const WORKSHEET_MESSAGES: ConversationMessage[] = [
  {
    id: "dimmer-user",
    author: "user",
    source: "user",
    text: "Can you send me the algebra worksheet? I want to do exercise 1 tonight.",
    createdAt: "2026-08-19T21:02:00.000Z",
    status: "completed",
  },
  {
    id: "dimmer-agent",
    author: "assistant",
    source: "assistant",
    text: [
      `Here it is: [${WORKSHEET_NAME}](${WORKSHEET_PATH})`,
      "",
      "Exercise 1 is the change of basis we did on Monday. Start with the matrix A, then check that B' is a basis.",
      "",
      `The whiteboard from Monday is here too: [${WHITEBOARD_NAME}](/mock/OpenBot/Agents/chief/${WHITEBOARD_NAME})`,
    ].join("\n"),
    createdAt: "2026-08-19T21:03:00.000Z",
    status: "completed",
  },
];

function snapshotsWithWorksheet() {
  const chief = STORY_SNAPSHOTS.chief;
  if (!chief) throw new Error("The chief story conversation is missing.");
  return { ...STORY_SNAPSHOTS, chief: { ...chief, messages: [...chief.messages, ...WORKSHEET_MESSAGES] } };
}

function WorksheetPlayground() {
  return (
    <OpenBotPlayground
      options={{ snapshots: snapshotsWithWorksheet() }}
      dependencies={{
        createMock: (options) => {
          const mock = createMockOpenBot(options);
          const previewWorkspaceFile = mock.api.agent.previewWorkspaceFile;
          mock.api.agent.previewWorkspaceFile = async (input) => {
            if (input.path.endsWith(WORKSHEET_NAME)) return WORKSHEET;
            if (input.path.endsWith(WHITEBOARD_NAME)) return WHITEBOARD;
            return previewWorkspaceFile(input);
          };
          return mock;
        },
        renderApp: () => <App />,
      }}
    />
  );
}

const meta = {
  title: "Conversation/FilePreviewDimmer",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const InApp: Story = {
  name: "In app (open the PDF from the chat)",
  render: () => <WorksheetPlayground />,
};

export const Panel: Story = {
  name: "Panel only",
  render: () => {
    const [width, setWidth] = createSignal(560);
    return (
      <div class="conversation-panel" style={`height: 100vh; --browser-panel-width: ${width()}px`}>
        <FilePreviewPanel
          preview={WORKSHEET}
          agents={STORY_AGENTS}
          maxWidth={() => 900}
          onWidthChange={setWidth}
          onOpenLink={fn()}
          onOpenSharedFile={fn()}
          onOpenExternally={fn()}
          onClose={fn()}
        />
      </div>
    );
  },
};
