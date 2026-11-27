/**
 * Fork (docs/fork/FEATURES.md #134, "Team board"): the side panel pane of a lead's team board. A row
 * opens the teammate's chat; Message opens it with the composer focused. The pressed row shows at once.
 */
import type { AgentProfile } from "@openbot/ui/data";
import { TeamBoardPane } from "@openbot/ui/features/conversation/TeamBoard";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { useTeamBoard } from "./team-board-store";

const OPENING_MS = 600;

export interface TeamBoardPanelProps {
  leadId: string;
  leadName: string;
  agents: readonly AgentProfile[];
  resizer?: JSX.Element;
  onOpenAgent: (agentId: string) => void;
  onMessageAgent: (agentId: string) => void;
}

export function TeamBoardPanel(props: TeamBoardPanelProps) {
  const board = useTeamBoard(() => props.leadId);
  const [opening, setOpening] = createSignal<string | null>(null);
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  const press = (agentId: string, action: (agentId: string) => void) => {
    setOpening(agentId);
    if (openingTimer) clearTimeout(openingTimer);
    openingTimer = setTimeout(() => setOpening(null), OPENING_MS);
    action(agentId);
  };
  return (
    <TeamBoardPane
      leadName={props.leadName}
      rows={board.lead() === undefined ? undefined : (board.lead()?.rows ?? [])}
      windowHours={board.windowHours()}
      error={board.error()}
      agents={props.agents}
      now={board.now()}
      opening={opening()}
      resizer={props.resizer}
      onOpenTeammate={(agentId) => press(agentId, props.onOpenAgent)}
      onMessageTeammate={(agentId) => press(agentId, props.onMessageAgent)}
      onRetry={board.refresh}
    />
  );
}
