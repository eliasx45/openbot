// @vitest-environment node
import { translateFor } from "@openbot/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted((): { title: string; body: string }[] => []);

vi.mock("electron", () => ({
  BrowserWindow: class {},
  Notification: class {
    constructor(options: { title: string; body: string }) {
      shown.push(options);
    }
    on() {}
    show() {}
  },
}));

const { createRendererForwarders } = await import("./renderer-forwarders");

function forwarders() {
  return createRendererForwarders({
    getMainWindow: () => null,
    getChatWindows: () => [],
    chatWindowTarget: () => null,
    getAgentService: () => null,
    getHostService: () => null,
    getHostAnalytics: () => null,
    getRemoteServerManager: () => null,
    ownAgentNotificationLevels: () => new Map(),
    showMainWindow: () => {},
    getTranslate: () => translateFor("en"),
    getFormat: () => {
      throw new Error("not used");
    },
    desktopNotificationsEnabled: () => true,
    notificationPreviewEnabled: () => true,
  });
}

beforeEach(() => {
  shown.length = 0;
});

describe("a workflow's notification", () => {
  it("shows the step's output as one line of plain text", () => {
    forwarders().forwardWorkflowNotice({
      kind: "output",
      workflowId: "w1",
      workflowTitle: "Morning digest",
      text: "## Digest\n\n**Three** new issues:\n\n- [Crash on start](https://example.com/1)\n- `cache.ts` leaks",
    });
    expect(shown).toEqual([{ title: "Morning digest", body: "Three new issues: Crash on start cache.ts leaks" }]);
  });
});
