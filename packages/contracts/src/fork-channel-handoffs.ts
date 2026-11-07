/*
 * Fork: which channel message is a handoff, for the desktop, web and phone views.
 *
 * The host posts each `channel_assign` / `channel_transfer` as a message of the assigning member,
 * `<recipient name>: <brief>`, as a reply to the request. Clients drew it as a full bubble with a
 * quote of the person's message, so a brief for another member read as an answer to the person
 * (Elias, 8 Nov 2026). The stored message has no handoff mark, so it is found from the task it
 * started: a child of the message's task (assign), or the same task with a new owner (transfer),
 * whose instruction is the text after the prefix. No wire or stored data changes.
 */

import type { ChannelMessage, ChannelTask } from "./ipc-chat-channels";

export interface ChannelHandoff {
  /** The member that gave the work. */
  senderAgentId: string;
  /** The member that got it. */
  recipientAgentId: string;
  /** The task the handoff started (assign) or moved (transfer). */
  task: ChannelTask;
  kind: "assigned" | "transferred";
  /** The brief, without the `<recipient>: ` prefix. */
  brief: string;
}

export function channelHandoff(entry: ChannelMessage, tasks: readonly ChannelTask[]): ChannelHandoff | null {
  const { message } = entry;
  if (entry.author.kind !== "agent" || !entry.taskId || message.author === "user" || message.status !== "completed")
    return null;
  const text = message.text;
  const task = tasks.find((candidate) => {
    if (candidate.parentTaskId !== entry.taskId && candidate.id !== entry.taskId) return false;
    if (!candidate.ownerAgentId || candidate.ownerAgentId === entry.author.id || !candidate.instruction) return false;
    if (!text.endsWith(`: ${candidate.instruction}`)) return false;
    const recipient = text.slice(0, text.length - candidate.instruction.length - 2);
    return recipient.length > 0 && !recipient.includes("\n");
  });
  if (!task?.ownerAgentId) return null;
  return {
    senderAgentId: entry.author.id,
    recipientAgentId: task.ownerAgentId,
    task,
    kind: task.id === entry.taskId ? "transferred" : "assigned",
    brief: task.instruction,
  };
}
