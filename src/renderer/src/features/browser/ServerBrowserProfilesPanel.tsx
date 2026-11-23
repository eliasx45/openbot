import type { AgentSummary, ChromeLink } from "@openbot/contracts/ipc";
import { type BrowserProfilesChrome, BrowserProfilesPanel } from "@openbot/ui/features/browser/BrowserProfilesPanel";
import type { BrowserProfileProxies } from "@openbot/ui/features/browser/BrowserProxies";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal } from "solid-js";
import { actionToast } from "../../action-toast";
import type { ChromeImportPort } from "./browser-profiles-port";
import type { BrowserProfilesStore } from "./stores/browser-profiles-store";

export interface ServerBrowserProfilesOptions {
  store: Omit<BrowserProfilesStore, "assign">;
  listAgents: () => Promise<readonly Pick<AgentSummary, "id" | "name">[]>;
  /** Fork (FEATURES.md 32): Chrome sign-ins, for this computer's own server only. */
  chrome?: ChromeImportPort | undefined;
}

export function ServerBrowserProfilesPanel(
  props: ServerBrowserProfilesOptions & { menuMount: HTMLElement | undefined },
) {
  const { t, errorMessage } = useText();
  const [agentNames, setAgentNames] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [chromeLinks, setChromeLinks] = createSignal<readonly ChromeLink[]>([]);
  const readChromeLinks = () => {
    props.chrome?.links().then(setChromeLinks, () => undefined);
  };
  let request = 0;
  createEffect(
    () => props.store,
    (store) => {
      const current = ++request;
      setAgentNames(new Map());
      store
        .refresh()
        .catch((error: unknown) => actionToast.error(errorMessage(error, t("browser.profiles.loadFailed"))));
      props.listAgents().then(
        (agents) => {
          if (current === request) setAgentNames(new Map(agents.map((agent) => [agent.id, agent.name])));
        },
        () => undefined,
      );
      readChromeLinks();
      return store.follow();
    },
  );
  const proxies = (): BrowserProfileProxies | undefined => {
    const list = props.store.state.proxies;
    if (!list) return undefined;
    return {
      list,
      computers: props.store.state.computers ?? [],
      sharing: props.store.state.sharing,
      onSave: props.store.saveProxy,
      onDelete: props.store.removeProxy,
      onSetProfileProxy: props.store.setProfileProxy,
      onSetSharing: props.store.setSharing,
    };
  };
  const chromeProps = (): BrowserProfilesChrome | undefined => {
    const chrome = props.chrome;
    if (!chrome) return undefined;
    return {
      links: chromeLinks(),
      calls: chrome,
      onImported: () => {
        void props.store.refresh();
        readChromeLinks();
      },
      onResync: async (profileId) => {
        const counts = await chrome.resync(profileId);
        readChromeLinks();
        return counts;
      },
    };
  };
  return (
    <BrowserProfilesPanel
      profiles={props.store.state.profiles}
      sharedAgentCount={props.store.state.sharedAgentIds?.length}
      agentName={(agentId) => agentNames().get(agentId)}
      onCreate={async (name) => {
        await props.store.create(name);
      }}
      onRename={props.store.rename}
      onRecolor={props.store.recolor}
      onClear={props.store.clear}
      onDelete={props.store.remove}
      menuMount={props.menuMount}
      proxies={proxies()}
      chrome={chromeProps()}
    />
  );
}
