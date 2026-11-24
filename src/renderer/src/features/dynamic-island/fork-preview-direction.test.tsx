import type { DynamicIslandAgentIdentity } from "@openbot/contracts/ipc";
import { AwaitingReplies } from "@openbot/ui/features/conversation/AwaitingReplies";
import { OpenBotDynamicIsland } from "@openbot/ui/features/dynamic-island/OpenBotDynamicIsland";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const ARABIC = "تم إصلاح الخلل في المحلل، وكل الاختبارات تمر الآن.";
const AGENT: DynamicIslandAgentIdentity = {
  id: "research",
  name: "باحث",
  avatarSeed: "research",
  avatarHue: null,
  avatarColor: null,
  avatarUrl: null,
};

function directionOf(container: HTMLElement, text: string): string | null {
  const element = Array.from(container.querySelectorAll("*")).find(
    (candidate) => candidate.children.length === 0 && candidate.textContent === text,
  );
  return element?.closest("[dir]")?.getAttribute("dir") ?? null;
}

describe("a right-to-left preview", () => {
  it("takes its direction from its text in the Dynamic Island", () => {
    const { container } = render(() => (
      <OpenBotDynamicIsland
        presentation={{
          serverId: "local",
          mode: "message",
          unreadCount: 1,
          message: { agent: AGENT, messageId: "reply", text: ARABIC, createdAt: "2026-11-24T10:00:00.000Z" },
        }}
        state="expanded"
        onStateChange={vi.fn()}
        onAction={vi.fn()}
      />
    ));
    expect(directionOf(container, ARABIC)).toBe("auto");
    expect(directionOf(container, AGENT.name)).toBe("auto");
  });

  it("takes its direction from its text in a working row of the Dynamic Island", () => {
    const { container } = render(() => (
      <OpenBotDynamicIsland
        presentation={{ serverId: "local", mode: "working", working: [{ agent: AGENT, task: ARABIC, turnId: "t1" }] }}
        state="expanded"
        onStateChange={vi.fn()}
        onAction={vi.fn()}
      />
    ));
    expect(directionOf(container, ARABIC)).toBe("auto");
  });

  it("takes its direction from its text in the waiting bar", () => {
    const { container } = render(() => (
      <AwaitingReplies items={[{ id: "a", name: "Research", state: "replied", preview: ARABIC }]} />
    ));
    expect(directionOf(container, ARABIC)).toBe("auto");
  });
});
