import type { ConversationSubagent, ConversationSubagentStep } from "@openbot/contracts/ipc";
import { focusLiveWork, LiveWorkDock, type LiveWorkItem } from "@openbot/ui/features/conversation/LiveWork";
import { SubagentGroup, SubagentPanel, subagentModelNames } from "@openbot/ui/features/conversation/Subagents";
import { createSignal, onSettled, untrack } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const STARTED = Date.now();

function at(secondsAgo: number): string {
  return new Date(STARTED - secondsAgo * 1_000).toISOString();
}

function steps(id: string, items: [ConversationSubagentStep["kind"], string][]): ConversationSubagentStep[] {
  return items.map(([kind, text], index) => ({ id: `${id}:${index}`, kind, text }));
}

const PRICING = steps("pricing", [
  ["thinking", "The pricing page probably reads its limits from a shared plan table. I find that first."],
  ["search", "agentLimit"],
  ["read", "apps/auth-api/src/components/pricing/PricingPage.tsx"],
  ["read", "packages/contracts/src/plans.ts"],
  ["thinking", "The page shows “5 agents” for Pro, but the contract allows 10. The page has its own copy."],
  ["search", "5 agents"],
  ["read", "apps/auth-api/src/components/pricing/plan-copy.ts"],
  [
    "text",
    "Two differences. Pro: the page says 5 agents, the contract allows 10 (plan-copy.ts:18). Team: the page says 20 agents, the contract allows 25 (plan-copy.ts:31).",
  ],
]);

const COMPETITORS = steps("competitors", [
  ["thinking", "Prices change often, so I use the pricing pages and not news articles."],
  ["web", "AI agent app team plan price per seat"],
  ["web", "https://example.com/pricing"],
  ["edit", "competitor-prices.md"],
  ["text", "I found public prices for 3 of the 5 apps. Two apps ask you to contact sales."],
]);

const NOTES = steps("notes", [
  ["thinking", "The notes come from changelog.d, one file per pull request."],
  ["command", "git log v0.41.0..HEAD --oneline"],
  ["read", "changelog.d"],
  ["edit", "release-notes-0.42.md"],
  ["text", "The draft has 12 entries in 3 groups: New, Better and Fixed."],
]);

const STAGING = steps("staging", [
  ["thinking", "The staging Worker writes its logs to Cloudflare. I read them with Wrangler."],
  ["command", "wrangler tail openbot-staging --format=json"],
]);

function subagent(
  id: string,
  title: string,
  all: ConversationSubagentStep[],
  shown: number,
  status: ConversationSubagent["status"],
  options: { agentType?: string; startedSecondsAgo: number; endedSecondsAgo?: number; error?: string },
): ConversationSubagent {
  return {
    id,
    title,
    agentType: options.agentType ?? "general-purpose",
    prompt: `${title}. Give the file and line of each finding. Do not change files.`,
    status,
    startedAt: at(options.startedSecondsAgo),
    endedAt: status === "running" ? null : at(options.endedSecondsAgo ?? 0),
    steps: all.slice(0, shown),
    error: options.error ?? null,
  };
}

const RUNNING: ConversationSubagent[] = [
  subagent("pricing", "Check the pricing page against the plan limits", PRICING, 3, "running", {
    agentType: "Explore",
    startedSecondsAgo: 48,
  }),
  subagent(
    "competitors",
    "Collect the team plan prices of comparable agent apps, with the source of each price",
    COMPETITORS,
    2,
    "running",
    { startedSecondsAgo: 46 },
  ),
  subagent("notes", "Draft the release notes for 0.42", NOTES, NOTES.length, "completed", {
    startedSecondsAgo: 130,
    endedSecondsAgo: 31,
  }),
];

const FINISHED: ConversationSubagent[] = [
  subagent("pricing", "Check the pricing page against the plan limits", PRICING, PRICING.length, "completed", {
    agentType: "Explore",
    startedSecondsAgo: 160,
    endedSecondsAgo: 70,
  }),
  subagent("notes", "Draft the release notes for 0.42", NOTES, NOTES.length, "completed", {
    startedSecondsAgo: 130,
    endedSecondsAgo: 31,
  }),
  subagent("staging", "Check the staging deploy logs", STAGING, STAGING.length, "failed", {
    startedSecondsAgo: 120,
    endedSecondsAgo: 90,
    error: "The token has no access to openbot-staging (403).",
  }),
  subagent("competitors", "Collect the team plan prices of comparable agent apps", COMPETITORS, 2, "stopped", {
    startedSecondsAgo: 110,
    endedSecondsAgo: 60,
  }),
];

const meta = {
  title: "Conversation/Subagents",
  component: SubagentGroup,
  render: (args) => {
    const [selected, setSelected] = createSignal<string | null>(untrack(() => args.selectedId ?? null));
    return (
      <main style={{ width: "min(760px, 100vw)", padding: "var(--openbot-space-4)" }}>
        <SubagentGroup
          {...args}
          selectedId={selected()}
          onOpen={(id) => setSelected((current) => (current === id ? null : id))}
        />
      </main>
    );
  },
  args: { subagents: RUNNING, onOpen: () => undefined },
  parameters: { layout: "centered", a11y: { test: "error" } },
} satisfies Meta<typeof SubagentGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};

export const Finished: Story = { args: { subagents: FINISHED } };

export const Selected: Story = { args: { selectedId: "pricing" } };

export const Panel: Story = {
  render: () => (
    <div style={{ position: "relative", width: "420px", height: "640px", display: "flex" }}>
      <SubagentPanel subagent={RUNNING[0]} agentName="Chief" onClosePanel={() => undefined} />
    </div>
  ),
};

export const PanelFailed: Story = {
  render: () => (
    <div style={{ position: "relative", width: "420px", height: "640px", display: "flex" }}>
      <SubagentPanel subagent={FINISHED[2]} agentName="Chief" onClosePanel={() => undefined} />
    </div>
  ),
};

export const Live: Story = {
  render: () => {
    const [tick, setTick] = createSignal(0);
    const last = PRICING.length + 6;
    onSettled(() => {
      const timer = window.setInterval(() => setTick((value) => (value >= last ? 0 : value + 1)), 900);
      return () => window.clearInterval(timer);
    });
    const subagents = (): ConversationSubagent[] => {
      const step = tick();
      const pricingDone = step >= PRICING.length;
      const competitorsDone = step >= COMPETITORS.length + 1;
      return [
        subagent(
          "pricing",
          "Check the pricing page against the plan limits",
          PRICING,
          Math.min(step + 1, PRICING.length),
          pricingDone ? "completed" : "running",
          { agentType: "Explore", startedSecondsAgo: 20 },
        ),
        subagent(
          "competitors",
          "Collect the team plan prices of comparable agent apps",
          COMPETITORS,
          Math.min(step, COMPETITORS.length),
          competitorsDone ? "completed" : "running",
          { startedSecondsAgo: 18 },
        ),
      ];
    };
    const [selected, setSelected] = createSignal<string | null>(null);
    return (
      <main style={{ width: "min(760px, 100vw)", padding: "var(--openbot-space-4)" }}>
        <SubagentGroup
          subagents={subagents()}
          selectedId={selected()}
          onOpen={(id) => setSelected((current) => (current === id ? null : id))}
        />
      </main>
    );
  },
};

/*
 * Fork (docs/fork/FEATURES.md #78): each subagent names the model and effort it runs on, for every
 * provider: Claude, Codex, and an ACP agent that reports no effort.
 */
const MODEL_NAMES = subagentModelNames([
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "gpt-5.5", name: "GPT-5.5" },
]);

const WITH_MODELS: ConversationSubagent[] = [
  ...RUNNING.slice(0, 2).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { model: "claude-opus-5-5", effort: "high" } : { model: "claude-haiku-4-5-20251001" }),
  })),
  {
    ...subagent("tests", "Run the release tests and report failures", NOTES, 2, "running", {
      startedSecondsAgo: 40,
    }),
    agentType: null,
    model: "gpt-5.5",
    effort: "xhigh",
  },
  {
    ...subagent("kimi", "Summarise the open issues", NOTES, 1, "running", { startedSecondsAgo: 12 }),
    model: "kimi-k3",
  },
];

/** Fork #78: each row names its model and effort, Claude, Codex or another provider. */
export const WithModels: Story = { args: { subagents: WITH_MODELS, modelNames: MODEL_NAMES } };

/** Fork #78: the side panel names the model and effort in its meta line. */
export const PanelWithModel: Story = {
  render: () => (
    <div style={{ position: "relative", width: "420px", height: "640px", display: "flex" }}>
      <SubagentPanel
        subagent={WITH_MODELS[0]}
        agentName="Chief"
        onClosePanel={() => undefined}
        modelNames={MODEL_NAMES}
      />
    </div>
  ),
};

function dockItems(subagents: readonly ConversationSubagent[]): LiveWorkItem[] {
  return subagents
    .filter((entry) => entry.status === "running")
    .map((entry) => ({ kind: "subagent", key: entry.id, cardId: "card", agentId: "chief", subagent: entry }));
}

function Dock(props: { subagents: readonly ConversationSubagent[]; models: boolean }) {
  onSettled(() => focusLiveWork("chief"));
  return (
    <main
      style={{ width: "min(760px, 100vw)", height: "420px", padding: "var(--openbot-space-4)", position: "relative" }}
    >
      <LiveWorkDock
        items={dockItems(props.subagents)}
        agentName={() => "Chief"}
        onOpenSubagent={() => undefined}
        onReveal={() => undefined}
        modelNames={props.models ? MODEL_NAMES : undefined}
      />
    </main>
  );
}

/** The "N working" dock, open, before fork #78: no model on a row. */
export const DockWithoutModels: Story = {
  render: () => (
    <Dock subagents={WITH_MODELS.map(({ model: _model, effort: _effort, ...rest }) => rest)} models={false} />
  ),
};

/** Fork #78: the "N working" dock, open: each row names its model and effort. */
export const DockWithModels: Story = { render: () => <Dock subagents={WITH_MODELS} models={true} /> };

/*
 * Fork (docs/fork/FEATURES.md #90): Antigravity (Gemini) subagents, as the cards that the ACP client
 * makes from `invoke_subagent` calls and the subagents' own sessions: the `Role` is the title,
 * `self` the type, and the steps are the subagent's tool calls and text. A subagent works on after
 * the turn (`background`) and ends when it reports to its parent with `send_message`.
 */
const HARVEST = steps("harvest", [
  ["read", "/Users/elias/.agents/skills/editing-harvest/SKILL.md"],
  ["read", "/Users/elias/Developer/motion-kit/shelf/README.md"],
  ["command", 'ffprobe -v error -show_entries stream=width,height,r_frame_rate "khizar-TL.mp4"'],
  ["thinking", "The loop repeats every 216 frames. I extract one loop and compare the frame cadence."],
  ["command", "python3 - khizar-TL.mp4 build/ <<'PY' … PY"],
]);

function geminiSubagent(
  id: string,
  title: string,
  shown: number,
  status: ConversationSubagent["status"],
  startedSecondsAgo: number,
  extra: Partial<ConversationSubagent> = {},
): ConversationSubagent {
  return {
    ...subagent(id, title, HARVEST, shown, status, { agentType: "self", startedSecondsAgo, endedSecondsAgo: 2 }),
    prompt: `Use the editing-harvest skill, harvester part (steps 1–4). Slug: ${id}.`,
    background: true,
    model: "gemini-4-neon",
    ...extra,
  };
}

const GEMINI_RUNNING: ConversationSubagent[] = [
  geminiSubagent("khizar-TL", "Khizar TL Quadrant Harvester", 5, "running", 70),
  geminiSubagent("khizar-TR", "Khizar TR Quadrant Harvester", 3, "running", 68),
  geminiSubagent("khizar-BL", "Khizar BL Quadrant Harvester", 4, "running", 67),
  geminiSubagent("khizar-BR", "Khizar BR Quadrant Harvester", 2, "running", 65),
  geminiSubagent("sfx-bench", "Blind SFX Skill Benchmark Agent", 1, "running", 14),
];

const GEMINI_ENDED: ConversationSubagent[] = [
  geminiSubagent("khizar-TL", "Khizar TL Quadrant Harvester", 5, "completed", 300, {
    steps: [
      ...HARVEST,
      { id: "khizar-TL:result", kind: "text", text: "khizar-TL harvested: 4 components on the shelf." },
    ],
  }),
  geminiSubagent("khizar-TR", "Khizar TR Quadrant Harvester", 3, "running", 298),
  geminiSubagent("khizar-BL", "Khizar BL Quadrant Harvester", 4, "stopped", 297),
  geminiSubagent("sfx-bench", "Blind SFX Skill Benchmark Agent", 0, "failed", 120, {
    error: "OpenBot found no session for this subagent, so it could not answer its approvals or show its work.",
  }),
];

const GEMINI_MODELS = subagentModelNames([{ id: "gemini-4-neon", name: "Gemini 4 Neon" }]);

/** Fork #90: five Antigravity subagents that work in the background after the turn. */
export const GeminiRunning: Story = { args: { subagents: GEMINI_RUNNING, modelNames: GEMINI_MODELS } };

/** Fork #90: one reported, one works, one was stopped, and one had no session to follow. */
export const GeminiEnded: Story = {
  args: { subagents: GEMINI_ENDED, modelNames: GEMINI_MODELS, selectedId: "khizar-TL" },
};

/** Fork #90: the side panel of an Antigravity subagent: its task, its steps and its report. */
export const GeminiPanel: Story = {
  render: () => (
    <div style={{ position: "relative", width: "420px", height: "640px", display: "flex" }}>
      <SubagentPanel
        subagent={GEMINI_ENDED[0]}
        agentName="Vegapunk"
        onClosePanel={() => undefined}
        modelNames={GEMINI_MODELS}
      />
    </div>
  ),
};

/** Fork #90: the "N working" dock with the Antigravity subagents. */
export const GeminiDock: Story = { render: () => <GeminiDockStory /> };

function GeminiDockStory() {
  onSettled(() => focusLiveWork("chief"));
  return (
    <main
      style={{ width: "min(760px, 100vw)", height: "420px", padding: "var(--openbot-space-4)", position: "relative" }}
    >
      <LiveWorkDock
        items={dockItems(GEMINI_RUNNING)}
        agentName={() => "Vegapunk"}
        onOpenSubagent={() => undefined}
        onReveal={() => undefined}
        modelNames={GEMINI_MODELS}
      />
    </main>
  );
}
