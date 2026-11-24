// @vitest-environment jsdom
import {
  CHANNEL_THREAD_REPLIER_LIMIT,
  channelThreadEntryIds,
  channelThreadRoots,
  channelThreads,
} from "@openbot/contracts/fork-channel-threads";
import type { ChannelMessage, ChannelTask } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  channelSendCommand,
  escClosesThread,
  feedRelativeTime,
  feedThreadToOpen,
  saveThreadDraft,
  threadDraft,
  threadPanelMaxWidth,
} from "./channel-feed";

let clock = Date.parse("2026-11-24T10:00:00.000Z");

function member(
  id: string,
  sequence: number,
  text: string,
  options: { replyTo?: string; author?: string; taskId?: string; superseded?: boolean } = {},
): ChannelMessage {
  clock += 60_000;
  return {
    id,
    channelId: "channel",
    sequence,
    author: { kind: "member", id: options.author ?? "me", name: options.author ?? "Me" },
    taskId: options.taskId ?? null,
    superseded: options.superseded ?? false,
    message: {
      id,
      author: "user",
      text,
      createdAt: new Date(clock).toISOString(),
      status: "completed",
      ...(options.replyTo ? { replyToMessageId: options.replyTo } : {}),
    },
  };
}

function agent(
  id: string,
  sequence: number,
  text: string,
  options: { agentId?: string; taskId?: string; replyTo?: string; superseded?: boolean; itemType?: string } = {},
): ChannelMessage {
  clock += 60_000;
  return {
    id,
    channelId: "channel",
    sequence,
    author: { kind: "agent", id: options.agentId ?? "ana", name: options.agentId ?? "Ana" },
    taskId: options.taskId ?? null,
    superseded: options.superseded ?? false,
    message: {
      id,
      author: "assistant",
      text,
      createdAt: new Date(clock).toISOString(),
      status: "completed",
      ...(options.replyTo ? { replyToMessageId: options.replyTo } : {}),
      ...(options.itemType ? { itemType: options.itemType } : {}),
    },
  };
}

function task(
  id: string,
  requestMessageId: string,
  sources: string[] = [requestMessageId],
  rootTaskId = id,
): ChannelTask {
  return {
    id,
    channelId: "channel",
    parentTaskId: rootTaskId === id ? null : rootTaskId,
    rootTaskId,
    ownerAgentId: "ana",
    requestMessageId,
    instruction: "",
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: sources,
    dependencies: [],
    resources: [],
    state: "completed",
    revision: 1,
    assignmentCount: 1,
    error: null,
  };
}

describe("the thread root resolver", () => {
  it("follows replyToMessageId chains back to the root", () => {
    const entries = [
      member("root", 1, "Plan the launch"),
      member("r1", 2, "First reply", { replyTo: "root" }),
      member("r2", 3, "Reply to the reply", { replyTo: "r1" }),
    ];
    const roots = channelThreadRoots(entries, []);
    expect(roots.get("r1")).toBe("root");
    expect(roots.get("r2")).toBe("root");
    expect(roots.get("root")).toBe("root");
  });

  it("treats a message whose parent is missing as a root", () => {
    const entries = [
      member("orphan", 5, "Late reply", { replyTo: "unloaded" }),
      member("child", 6, "x", { replyTo: "orphan" }),
    ];
    const roots = channelThreadRoots(entries, []);
    expect(roots.get("orphan")).toBe("orphan");
    expect(roots.get("child")).toBe("orphan");
  });

  it("treats a deleted parent as missing", () => {
    const deleted = { ...member("gone", 1, ""), deleted: true };
    const entries = [deleted, member("after", 2, "Still here", { replyTo: "gone" })];
    expect(channelThreadRoots(entries, []).get("after")).toBe("after");
  });

  it("keeps the answer to a deleted thread reply in the thread of the root", () => {
    const entries = [
      member("root", 1, "Write it", { taskId: "t1" }),
      { ...member("gone", 2, "", { taskId: "t1" }), deleted: true },
      agent("answer", 3, "Done", { taskId: "t1" }),
    ];
    expect(channelThreadRoots(entries, [task("t1", "gone", ["root", "gone"])]).get("answer")).toBe("root");
  });

  it("keeps the replies of a deleted root together under the oldest one", () => {
    const entries = [
      { ...member("gone", 1, "", { taskId: "t1" }), deleted: true },
      agent("answer", 2, "Done", { taskId: "t1" }),
      member("reply", 3, "Thanks", { replyTo: "gone" }),
      agent("next", 4, "Welcome", { replyTo: "reply" }),
    ];
    const feed = channelThreads(entries, [task("t1", "gone")]);
    expect(feed.roots.map((root) => root.id)).toEqual(["answer"]);
    expect(feed.summaries.get("answer")?.replies).toBe(2);
  });

  it("ends a reply cycle at its oldest message", () => {
    const entries = [
      member("a", 1, "A", { replyTo: "b" }),
      member("b", 2, "B", { replyTo: "a" }),
      member("c", 3, "C", { replyTo: "b" }),
    ];
    const roots = channelThreadRoots(entries, []);
    expect(roots.get("a")).toBe("a");
    expect(roots.get("b")).toBe("a");
    expect(roots.get("c")).toBe("a");
  });

  it("puts an answer without replyToMessageId into the thread of its request", () => {
    const entries = [
      member("root", 1, "Ask Ana", { taskId: "t1" }),
      agent("answer", 2, "Done", { taskId: "t1" }),
      member("other", 3, "Unrelated root"),
    ];
    const roots = channelThreadRoots(entries, [task("t1", "root")]);
    expect(roots.get("answer")).toBe("root");
    expect(roots.get("other")).toBe("other");
  });

  it("sends a continued task's later answers to the message that continued it", () => {
    const entries = [
      member("root", 1, "Write the notes", { taskId: "t1" }),
      agent("first", 2, "Draft", { taskId: "t1", superseded: true }),
      member("reply", 3, "Shorter", { taskId: "t1", replyTo: "root" }),
      agent("second", 4, "Short draft", { taskId: "t1" }),
      member("yes", 5, "yes", { taskId: "t1" }),
      agent("third", 6, "Posted", { taskId: "t1" }),
    ];
    const tasks = [{ ...task("t1", "yes", ["root", "reply", "yes"]) }];
    const roots = channelThreadRoots(entries, tasks);
    expect(roots.get("first")).toBe("root");
    expect(roots.get("second")).toBe("root");
    expect(roots.get("third")).toBe("yes");
  });

  it("puts a subtask's answer into the thread of the root task's request", () => {
    const entries = [
      member("root", 1, "Ask the team", { taskId: "t1" }),
      agent("ben", 2, "My part", { agentId: "ben", taskId: "s1" }),
    ];
    const tasks = [task("t1", "root"), { ...task("s1", "root", ["handoff"], "t1"), ownerAgentId: "ben" }];
    expect(channelThreadRoots(entries, tasks).get("ben")).toBe("root");
  });

  it("keeps a handoff line in its task's thread when it cites a message of another thread", () => {
    const entries = [
      member("elsewhere", 1, "Old notes"),
      member("root", 2, "Ask the team", { taskId: "t1" }),
      {
        ...agent("handoff", 3, "Ben: check the old notes", { taskId: "t1", replyTo: "elsewhere" }),
        message: {
          ...agent("z", 3, "Ben: check the old notes").message,
          id: "handoff",
          author: "system" as const,
          replyToMessageId: "elsewhere",
        },
      },
    ];
    expect(channelThreadRoots(entries, [task("t1", "root")]).get("handoff")).toBe("root");
  });
});

describe("the feed", () => {
  it("lists roots oldest first and a reply never reorders them", () => {
    const entries = [
      member("one", 1, "First"),
      member("two", 2, "Second"),
      member("three", 3, "Third"),
      member("late", 4, "Reply to the first", { replyTo: "one" }),
    ];
    const feed = channelThreads(entries, []);
    expect(feed.roots.map((root) => root.id)).toEqual(["one", "two", "three"]);
    expect(channelThreads([...entries].reverse(), []).roots.map((root) => root.id)).toEqual(["one", "two", "three"]);
  });

  it("keeps system rows, routing markers and thinking off the feed", () => {
    const entries = [
      member("root", 1, "Ask", { taskId: "t1" }),
      {
        ...agent("routing", 2, "Assigned to Ana.", { taskId: "t1" }),
        message: {
          ...agent("x", 2, "Assigned to Ana.").message,
          id: "routing",
          author: "system" as const,
          itemType: "channel-routing-event:assigned:ana",
        },
      },
      agent("thinking", 3, "Looking", { itemType: "commentary" }),
      {
        ...agent("note", 4, "Ana joined"),
        message: {
          ...agent("y", 4, "Ana joined").message,
          id: "note",
          author: "system" as const,
          itemType: "channel-change",
        },
      },
    ];
    const feed = channelThreads(entries, [task("t1", "root")]);
    expect(feed.roots.map((root) => root.id)).toEqual(["root"]);
    expect(feed.rootOf.get("routing")).toBe("root");
    expect(channelThreadEntryIds("root", feed.rootOf)).toEqual(new Set(["root", "routing"]));
  });

  it("shows an agent's own post as a root", () => {
    const feed = channelThreads([agent("post", 1, "Daily status")], []);
    expect(feed.roots.map((root) => root.id)).toEqual(["post"]);
  });
});

describe("the thread summaries", () => {
  it("counts replies, the last reply and at most three distinct repliers, newest first", () => {
    const entries = [
      member("root", 1, "Plan the launch", { taskId: "t1" }),
      agent("a1", 2, "Plan A", { taskId: "t1", agentId: "ana" }),
      member("m1", 3, "Ben?", { replyTo: "root", author: "kim" }),
      agent("b1", 4, "Plan B", { replyTo: "m1", agentId: "ben" }),
      agent("c1", 5, "Plan C", { replyTo: "m1", agentId: "cleo" }),
      agent("a2", 6, "Merged", { replyTo: "c1", agentId: "ana" }),
      member("other", 7, "Another thread"),
    ];
    const feed = channelThreads(entries, [task("t1", "root")]);
    const summary = feed.summaries.get("root");
    expect(summary?.replies).toBe(5);
    expect(summary?.lastReplyAt).toBe(entries[5]?.message.createdAt);
    expect(summary?.repliers.map((author) => author.id)).toEqual(["ana", "cleo", "ben"]);
    expect(summary?.repliers.length).toBeLessThanOrEqual(CHANNEL_THREAD_REPLIER_LIMIT);
    expect(feed.summaries.get("other")).toEqual({ rootId: "other", replies: 0, lastReplyAt: null, repliers: [] });
  });

  it("counts superseded answers, which the thread still shows, and leaves out markers, thinking and deleted rows", () => {
    const entries = [
      member("root", 1, "Write it", { taskId: "t1" }),
      agent("old", 2, "Old draft", { taskId: "t1", superseded: true }),
      agent("steps", 3, "Thinking", { taskId: "t1", itemType: "commentary" }),
      { ...member("removed", 4, "", { replyTo: "root" }), deleted: true },
      agent("new", 5, "New draft", { taskId: "t1" }),
    ];
    const summary = channelThreads(entries, [task("t1", "root")]).summaries.get("root");
    expect(summary?.replies).toBe(2);
    expect(summary?.lastReplyAt).toBe(entries[4]?.message.createdAt);
    expect(summary?.repliers.map((author) => author.id)).toEqual(["ana"]);
  });
});

describe("the send targets", () => {
  it("sends a thread panel reply to the root and addresses the leading mention", () => {
    const command = channelSendCommand({
      channelId: "channel",
      text: "@[Ben](agent:ben) what do you think?",
      operationId: "op",
      replyToMessageId: "root",
      attachmentDraftIds: [],
    });
    expect(command).toMatchObject({ type: "send", replyToMessageId: "root", recipientAgentId: "ben" });
  });

  it("opens the thread that a feed send landed in: its own for a new root, the quoted one for a reply", () => {
    const feed = channelThreads(
      [member("root", 1, "Plan"), member("fresh", 2, "New"), member("quoted", 3, "Re", { replyTo: "root" })],
      [],
    );
    expect(feedThreadToOpen("fresh", feed.rootOf)).toBe("fresh");
    expect(feedThreadToOpen("quoted", feed.rootOf)).toBe("root");
    expect(feedThreadToOpen("unknown", feed.rootOf)).toBe("unknown");
  });
});

describe("the thread panel", () => {
  it("keeps a reply draft per thread until it is sent or emptied", () => {
    saveThreadDraft("channel", "root", "half a reply");
    expect(threadDraft("channel", "root")).toBe("half a reply");
    expect(threadDraft("channel", "other")).toBe("");
    expect(threadDraft("other-channel", "root")).toBe("");
    saveThreadDraft("channel", "root", "  ");
    expect(threadDraft("channel", "root")).toBe("");
  });

  it("closes on Esc from the panel or the feed, but not from the feed composer or an open menu", () => {
    document.body.innerHTML = `
      <section id="feed"><button id="row"></button></section>
      <div class="composer"><div id="feed-editor" contenteditable="true"></div></div>
      <aside id="panel"><div id="panel-editor" contenteditable="true"></div>
        <div role="menu"><div id="item"></div></div></aside>`;
    const panel = document.getElementById("panel");
    const at = (id: string) => document.getElementById(id);
    expect(escClosesThread(at("row"), panel)).toBe(true);
    expect(escClosesThread(at("panel-editor"), panel)).toBe(true);
    expect(escClosesThread(document.body, panel)).toBe(true);
    expect(escClosesThread(at("feed-editor"), panel)).toBe(false);
    expect(escClosesThread(at("item"), panel)).toBe(false);
  });

  it("keeps the feed at least 360 px wide beside the panel", () => {
    expect(threadPanelMaxWidth(1200)).toBe(840);
    expect(threadPanelMaxWidth(600)).toBe(360);
  });

  it("writes relative reply times", () => {
    const now = Date.parse("2026-11-24T12:00:00.000Z");
    expect(feedRelativeTime("2026-11-24T11:59:40.000Z", now, "en", "just now")).toBe("just now");
    expect(feedRelativeTime("2026-11-24T11:55:00.000Z", now, "en", "just now")).toContain("5");
    expect(feedRelativeTime("2026-11-23T12:00:00.000Z", now, "en", "just now")).toBe("yesterday");
  });
});
