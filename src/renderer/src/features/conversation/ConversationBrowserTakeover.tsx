import { BrowserTakeoverCard } from "@openbot/ui/features/conversation/ConversationPrompts";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, Loading, Show } from "solid-js";
import { actionToast } from "../../action-toast";
import { browserSecretVault } from "./browser-secret-vault";
import { conversationRuntime } from "./conversation-runtime";
import { useConversationViewScope } from "./conversation-scope";

/**
 * The browser takeover of the open thread, with the secure card for a code or a password, and its result
 * after the user answers. The agent's chat and an open side thread show it.
 */
export function ConversationBrowserTakeover() {
  const {
    props,
    channel,
    browserTakeoverPreview,
    browserTakeoverResolution,
    browserTakeoverTab,
    openBrowserTakeoverTab,
    localSignIn,
    respondToBrowserTakeover,
  } = useConversationViewScope();
  const { t, errorMessage } = useText();
  const runtime = conversationRuntime(props);
  // Fork (FEATURES.md 32): the site whose Chrome sign-in the takeover tab can take. This computer only.
  const [chromeSite, setChromeSite] = createSignal<string | null>(null);
  createEffect(
    () => (props.server?.kind === "local" ? props.browserTakeover?.tabId : undefined),
    (tabId) => {
      setChromeSite(null);
      if (!tabId) return;
      window.openbot.agent.getChromeSignInSite(tabId).then(
        (site) => {
          if (props.browserTakeover?.tabId === tabId) setChromeSite(site);
        },
        () => undefined,
      );
    },
  );
  const useChromeSignIn = async (): Promise<boolean> => {
    const tabId = props.browserTakeover?.tabId;
    if (!tabId) return false;
    try {
      const result = await window.openbot.agent.signInWithChrome(tabId);
      actionToast.success(t("browser.chrome.signedIn", { site: result.site }));
      return await respondToBrowserTakeover("complete");
    } catch (error) {
      actionToast.error(errorMessage(error, t("browser.chrome.failed")));
      return false;
    }
  };
  /** The agent that asks in a card: in a channel, the working agent whose card shows. */
  const agentName = () =>
    (channel ? channel.interactionAgentName() : props.agent?.name) ?? t("chat.message.agentFallback");
  return (
    <>
      <Show when={props.browserTakeover}>
        <Loading>
          <BrowserTakeoverCard
            request={props.browserTakeover}
            agentName={agentName()}
            tab={browserTakeoverTab()}
            preview={browserTakeoverPreview().preview}
            previewStatus={browserTakeoverPreview().status}
            onOpen={openBrowserTakeoverTab}
            onComplete={() => respondToBrowserTakeover("complete")}
            onCancel={() => respondToBrowserTakeover("cancel")}
            onSignInLocally={localSignIn.canStartForTakeover() ? localSignIn.startForTakeover : undefined}
            signInBlocked={localSignIn.blockedTakeover()}
            onUseChromeSignIn={chromeSite() ? useChromeSignIn : undefined}
            browserSecret={{
              loadPreview: runtime.browser.capturePreview,
              vault: browserSecretVault(props.server),
              onRespond: runtime.agent.respondToBrowserSecret,
            }}
          />
        </Loading>
      </Show>
      <Show when={!props.browserTakeover && browserTakeoverResolution()}>
        {(resolution) => (
          <BrowserTakeoverCard
            agentName={agentName()}
            tab={resolution().tab}
            preview={resolution().preview}
            previewStatus={resolution().previewStatus}
            decision={resolution().decision}
            signInBlocked={resolution().signInBlocked}
            onComplete={async () => false}
            onCancel={async () => false}
          />
        )}
      </Show>
    </>
  );
}
