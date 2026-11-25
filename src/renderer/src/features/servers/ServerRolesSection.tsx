import type {
  AgentAccessChange,
  AgentAccessRole,
  AgentAccessSnapshot,
  OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import { AGENT_ACCESS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-access-v1";
import { Alert, AlertContent, AlertDescription } from "@openbot/ui";
import {
  type RoleAgent,
  type RoleChannel,
  type ServerRolePage,
  ServerRolesPanel,
} from "@openbot/ui/features/servers/ServerRoles";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createStore, Show, untrack } from "solid-js";
import { serverCanAdminister } from "./server-capabilities";
import type { ServerSettingsSectionHost } from "./server-settings-section";

export type HostAgentAccessCalls = Pick<OpenBotDesktopApi["hostAdmin"], "getAgentAccess" | "setAgentAccess">;

export interface ServerAgentAccessOptions {
  calls?: HostAgentAccessCalls;
  listAgents: () => Promise<readonly RoleAgent[]>;
  listChannels?: () => Promise<readonly RoleChannel[]>;
}

interface RolesState {
  snapshot: AgentAccessSnapshot | null;
  agents: readonly RoleAgent[];
  channels: readonly RoleChannel[];
  loadError: string | null;
  page: ServerRolePage;
}

export interface ServerRolesSection {
  available: () => boolean;
  Panel: () => JSX.Element;
  crumb: () => { title: string; back: () => void } | null;
  roles: () => readonly AgentAccessRole[] | undefined;
  setMemberRole(roleId: string, memberId: string, on: boolean): void;
  resetForServer(): void;
}

function copyChange(snapshot: AgentAccessSnapshot): AgentAccessChange {
  return {
    revision: snapshot.revision,
    everyone: { ...snapshot.everyone },
    roles: (snapshot.roles ?? []).map((role) => ({
      ...role,
      agents: { ...role.agents },
      memberIds: [...role.memberIds],
      ...(role.channels === undefined ? {} : { channels: { ...role.channels } }),
    })),
    ...(snapshot.everyoneChannels === undefined ? {} : { everyoneChannels: { ...snapshot.everyoneChannels } }),
  };
}

export function createServerRolesSection(host: ServerSettingsSectionHost, visible: () => boolean): ServerRolesSection {
  const { t, errorMessage } = useText();
  const { props, configured, actionsAvailable, busy, run } = host;
  const calls = (): HostAgentAccessCalls => props.agentAccess?.calls ?? window.openbot.hostAdmin;
  const [state, setState] = createStore<RolesState>({
    snapshot: null,
    agents: [],
    channels: [],
    loadError: null,
    page: { kind: "list" },
  });
  let generation = 0;

  const available = () =>
    Boolean(props.agentAccess) &&
    configured() &&
    actionsAvailable() &&
    serverCanAdminister(props.server, AGENT_ACCESS_CAPABILITY);

  function load(serverId: string): void {
    const options = props.agentAccess;
    if (!options) return;
    const current = ++generation;
    Promise.all([
      calls().getAgentAccess(serverId),
      options.listAgents(),
      options.listChannels?.().catch(() => []) ?? Promise.resolve([]),
    ]).then(
      ([snapshot, agents, channels]) => {
        if (current !== generation) return;
        setState((draft) => {
          draft.snapshot = snapshot;
          draft.agents = [...agents];
          draft.channels = channels.map(({ id, name }) => ({ id, name }));
          draft.loadError = null;
        });
      },
      (error: unknown) => {
        if (current !== generation) return;
        setState((draft) => {
          draft.loadError = errorMessage(error, t("server.roles.loadFailed"));
        });
      },
    );
  }

  createEffect(
    () => (props.open && visible() && available() ? props.server.id : null),
    (serverId) => {
      if (serverId) untrack(() => load(serverId));
    },
  );

  function save(edit: (change: AgentAccessChange) => void, after?: () => void): void {
    const snapshot = state.snapshot;
    if (!snapshot?.everyone || !snapshot.roles) return;
    const change = copyChange(snapshot);
    edit(change);
    const serverId = props.server.id;
    const request = generation;
    void run("roles", async () => {
      try {
        const next = await calls().setAgentAccess(change, serverId);
        if (request !== generation) return;
        setState((draft) => {
          draft.snapshot = next;
        });
        after?.();
      } catch (error) {
        if (request === generation) load(serverId);
        throw error;
      }
    });
  }

  function setPage(page: ServerRolePage): void {
    setState((draft) => {
      draft.page = page;
    });
  }

  function editRole(roleId: string, edit: (role: AgentAccessRole) => void) {
    save((change) => {
      const role = change.roles.find((item) => item.id === roleId);
      if (role) edit(role);
    });
  }

  function Panel() {
    return (
      <>
        <Show when={state.loadError}>
          {(message) => (
            <Alert tone="danger" role="alert">
              <AlertContent>
                <AlertDescription>{message()}</AlertDescription>
              </AlertContent>
            </Alert>
          )}
        </Show>
        <Show when={state.snapshot}>
          {(snapshot) => (
            <ServerRolesPanel
              agents={[...state.agents]}
              everyone={snapshot().everyone ?? {}}
              roles={snapshot().roles ?? []}
              channels={snapshot().everyoneChannels === undefined ? undefined : [...state.channels]}
              everyoneChannels={snapshot().everyoneChannels}
              onSetEveryoneChannelLevels={(levels) =>
                save((change) => {
                  const everyoneChannels = { ...change.everyoneChannels };
                  for (const [channelId, level] of levels) everyoneChannels[channelId] = level;
                  change.everyoneChannels = everyoneChannels;
                })
              }
              onSetRoleChannelLevels={(roleId, levels) =>
                editRole(roleId, (role) => {
                  const channels = { ...role.channels };
                  for (const [channelId, level] of levels) channels[channelId] = level;
                  role.channels = channels;
                })
              }
              page={state.page}
              disabled={Boolean(busy())}
              menuMount={host.menuMount()}
              onPage={setPage}
              onCreate={() => {
                const id = crypto.randomUUID();
                save(
                  (change) => {
                    change.roles.push({ id, name: t("server.roles.newRole"), agents: {}, memberIds: [] });
                  },
                  () => setPage({ kind: "role", roleId: id }),
                );
              }}
              onRename={(roleId, name) =>
                editRole(roleId, (role) => {
                  role.name = name;
                })
              }
              onDelete={(roleId) =>
                save(
                  (change) => {
                    change.roles = change.roles.filter((role) => role.id !== roleId);
                  },
                  () => setPage({ kind: "list" }),
                )
              }
              onSetEveryoneLevels={(levels) =>
                save((change) => {
                  for (const [agentId, level] of levels) change.everyone[agentId] = level;
                })
              }
              onSetRoleLevels={(roleId, levels) =>
                editRole(roleId, (role) => {
                  for (const [agentId, level] of levels) role.agents[agentId] = level;
                })
              }
            />
          )}
        </Show>
      </>
    );
  }

  return {
    available,
    Panel,
    crumb() {
      const page = state.page;
      const back = () => setPage({ kind: "list" });
      if (page.kind === "everyone") return { title: t("server.roles.everyone"), back };
      if (page.kind !== "role") return null;
      const role = state.snapshot?.roles?.find((item) => item.id === page.roleId);
      return role ? { title: role.name, back } : null;
    },
    roles: () => (available() ? state.snapshot?.roles : undefined),
    setMemberRole(roleId, memberId, on) {
      editRole(roleId, (role) => {
        role.memberIds = on
          ? [...role.memberIds.filter((id) => id !== memberId), memberId]
          : role.memberIds.filter((id) => id !== memberId);
      });
    },
    resetForServer() {
      generation++;
      setState((draft) => {
        draft.snapshot = null;
        draft.agents = [];
        draft.channels = [];
        draft.loadError = null;
        draft.page = { kind: "list" };
      });
    },
  };
}
