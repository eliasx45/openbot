import type { DynamicIslandAgentIdentity, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import { OpenBotDynamicIsland } from "@openbot/ui/features/dynamic-island/OpenBotDynamicIsland";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const AGENT: DynamicIslandAgentIdentity = {
  id: "research",
  name: "Research",
  avatarSeed: "research",
  avatarHue: null,
  avatarColor: null,
  avatarUrl: null,
};

function renderIsland(presentation: DynamicIslandPresentation) {
  return render(() => (
    <OpenBotDynamicIsland presentation={presentation} state="expanded" onStateChange={vi.fn()} onAction={vi.fn()} />
  ));
}

function descriptions(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll(".ui-dynamic-island-identity-description, .dynamic-island-surface-row small"),
    (element) => element.textContent ?? "",
  );
}

describe("text in the Dynamic Island", () => {
  it("shows a reply without its Markdown marks", () => {
    const { container } = renderIsland({
      serverId: "local",
      mode: "message",
      unreadCount: 1,
      message: {
        agent: AGENT,
        messageId: "reply",
        text: "## Summary\n\n**Done.** Run `bun test` and see [the report](https://example.com/report).<br>$$x^2$$",
        createdAt: "2026-11-24T10:00:00.000Z",
      },
    });
    expect(descriptions(container)).toEqual(["Summary Done. Run bun test and see the report. x²"]);
  });

  it("shows a question without its Markdown marks", () => {
    const { container } = renderIsland({
      serverId: "local",
      mode: "question",
      remainingCount: 0,
      item: {
        requestId: "question",
        agent: AGENT,
        title: "Question",
        detail: null,
        questions: [
          {
            id: "target",
            header: "Target",
            question: "Which **deploy target** should I use: `prod` or `staging`?",
            isSecret: false,
            options: null,
          },
        ],
      },
    });
    expect(descriptions(container)).toEqual(["Which deploy target should I use: prod or staging?"]);
  });

  it("shows a working task with tagged files and agents by name", () => {
    const { container } = renderIsland({
      serverId: "local",
      mode: "working",
      working: [
        {
          agent: AGENT,
          task: "Compare @[report.pdf](attachment:att-1) with **the notes** from @[Chief](agent:chief)",
          turnId: "turn-1",
        },
      ],
    });
    expect(descriptions(container)).toEqual(["Compare report.pdf with the notes from @Chief"]);
  });
});
