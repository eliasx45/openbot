import type { InstalledSkill } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { conversationRuntime } from "../conversation-runtime";
import type { ConversationProps } from "../conversation-types";
import { type ChannelSkill, channelSkills } from "../fork-channel-skills";
import { installedSkillsRequestKey } from "../installed-skills-source";

export interface SkillsStoreDeps {
  props: ConversationProps;
  settingsOpen: () => boolean;
}

export function createSkillsStore(deps: SkillsStoreDeps) {
  const [installedSkills, setInstalledSkills] = createSignal<ChannelSkill[]>([]);
  const [installedSkillsLoadFailed, setInstalledSkillsLoadFailed] = createSignal(false);
  const [installedSkillsRetry, setInstalledSkillsRetry] = createSignal(0);
  let installedSkillsRequest = 0;
  let installedSkillsSourceId: string | undefined;
  let failedInstalledSkillsAttempt: { serverId: string; sourceId: string; connectionSequence: number } | undefined;
  const installedSkillsSource = createMemo(() =>
    installedSkillsRequestKey(deps.props.agent?.id, deps.props.server, deps.props.skillsMarketplaceOpen === true),
  );
  createEffect(
    () => `${deps.props.server?.id ?? "local"}\0${deps.props.server?.connectionSequence ?? 0}`,
    (source) => {
      const [serverId = "", connectionSequenceText] = source.split("\0");
      const failedAttempt = failedInstalledSkillsAttempt;
      if (
        failedAttempt?.serverId === serverId &&
        failedAttempt.sourceId === `${serverId}\0${untrack(() => deps.props.agent?.id) ?? ""}` &&
        failedAttempt.connectionSequence !== Number(connectionSequenceText)
      ) {
        setInstalledSkillsRetry((retry) => retry + 1);
      }
    },
  );
  // Fork (docs/fork/FEATURES.md, "`$` in channels"): a channel reads the skills of each member.
  const channelMembers = createMemo(() =>
    deps.props.channel ? (deps.props.mentionAgents ?? []).map((agent) => agent.id).join(",") : "",
  );
  const refreshKey = createMemo(
    () =>
      `${installedSkillsSource()}\0${installedSkillsRetry()}\0${deps.props.activeTurnId ?? ""}\0${deps.settingsOpen()}\0${channelMembers()}`,
  );
  createEffect(refreshKey, (source) => {
    const request = ++installedSkillsRequest;
    const [serverId = "", agentId, support, visibility, , , , members] = source.split("\0");
    if (!agentId && members && support !== "unsupported") {
      if (visibility === "hidden") return;
      installedSkillsSourceId = undefined;
      failedInstalledSkillsAttempt = undefined;
      const agents = untrack(() => deps.props.mentionAgents ?? []);
      const runtime = conversationRuntime(deps.props);
      void Promise.all(
        agents.map((agent) =>
          runtime.agent
            .listInstalledSkills(agent.id)
            // One member that does not answer leaves its skills out, not the others'.
            .catch((): InstalledSkill[] => [])
            .then((skills) => ({ agent, skills })),
        ),
      ).then((lists) => {
        if (request !== installedSkillsRequest) return;
        setInstalledSkills(channelSkills(lists));
        setInstalledSkillsLoadFailed(false);
      });
      return;
    }
    if (!agentId) {
      installedSkillsSourceId = undefined;
      failedInstalledSkillsAttempt = undefined;
      setInstalledSkills([]);
      setInstalledSkillsLoadFailed(false);
      return;
    }
    if (visibility === "hidden") return;
    const sourceId = `${serverId}\0${agentId}`;
    if (installedSkillsSourceId !== sourceId) {
      installedSkillsSourceId = sourceId;
      setInstalledSkills([]);
      setInstalledSkillsLoadFailed(false);
    }
    if (support === "unsupported") {
      failedInstalledSkillsAttempt = undefined;
      setInstalledSkills([]);
      setInstalledSkillsLoadFailed(false);
      return;
    }
    const connectionSequence = untrack(() => deps.props.server?.connectionSequence) ?? 0;
    failedInstalledSkillsAttempt = undefined;
    void conversationRuntime(deps.props)
      .agent.listInstalledSkills(agentId)
      .then((skills) => {
        if (request !== installedSkillsRequest) return;
        failedInstalledSkillsAttempt = undefined;
        setInstalledSkills(skills);
        setInstalledSkillsLoadFailed(false);
      })
      .catch(() => {
        if (request !== installedSkillsRequest) return;
        failedInstalledSkillsAttempt = { serverId, sourceId, connectionSequence };
        setInstalledSkillsLoadFailed(true);
        // Preserve an already loaded same-agent catalog when a refresh fails.
      });
  });

  return {
    installedSkills,
    installedSkillsLoadFailed,
  };
}
