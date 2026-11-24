import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";

export function agentPreviewLine(preview: string): string {
  return markdownPreviewText(cleanAgentMessageText(preview));
}
