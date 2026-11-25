import type {
  AgentSectionInheritance,
  InheritedSectionLayer,
  SetSectionOptOutInput,
} from "@openbot/contracts/fork-section-defaults";
import { sectionLayerHasDefaults } from "@openbot/contracts/fork-section-defaults";
import { Badge, Button, Switch } from "@openbot/ui";
import { SettingsPanelContent, SettingsPanelHeader } from "@openbot/ui/components/SettingsPanel";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { MarkdownMessageText } from "./MarkdownMessageText";

export interface AgentSectionDefaultsCalls {
  load: (agentId: string) => Promise<AgentSectionInheritance>;
  setOptOut: (input: SetSectionOptOutInput) => Promise<AgentSectionInheritance>;
  openLink: (url: string) => void;
}

export function AgentSectionDefaultsView(props: {
  agentId: string;
  calls: AgentSectionDefaultsCalls;
  onEditSection: (sectionId: string) => void;
  onBack: () => void;
  onClose: () => void;
}): JSX.Element {
  const { t, errorMessage } = useText();
  const [inheritance, setInheritance] = createSignal<AgentSectionInheritance | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal<string | null>(null);
  let request = 0;

  createEffect(
    () => props.agentId,
    (agentId) => {
      const current = ++request;
      setInheritance(null);
      setError(null);
      props.calls.load(agentId).then(
        (loaded) => {
          if (current === request) setInheritance(loaded);
        },
        (failure: unknown) => {
          if (current === request) setError(errorMessage(failure, t("agentSettings.section.loadFailed")));
        },
      );
    },
  );

  async function setUsed(kind: "skill" | "mcp", id: string, used: boolean): Promise<void> {
    setSaving(`${kind}:${id}`);
    setError(null);
    try {
      setInheritance(await props.calls.setOptOut({ agentId: props.agentId, kind, id, optedOut: !used }));
    } catch (failure) {
      setError(errorMessage(failure, t("agentSettings.section.loadFailed")));
    } finally {
      setSaving(null);
    }
  }

  const folder = () => inheritance()?.path.join(" / ") ?? "";
  const shared = () => inheritance()?.layers.filter(sectionLayerHasDefaults) ?? [];

  return (
    <div class="agent-memories-view">
      <SettingsPanelHeader
        title={t("agentSettings.section.title", { folder: folder() })}
        onBack={props.onBack}
        backLabel={t("agentSettings.backToSettings")}
        onClose={props.onClose}
        closeLabel={t("agentSettings.closeDetails")}
      />
      <SettingsPanelContent>
        <div class="agent-memories-page section-inherited-page">
          <Show when={inheritance()}>
            {(current) => (
              <>
                <p class="section-inherited-description">{t("agentSettings.section.description")}</p>
                <Show
                  when={shared().length > 0}
                  fallback={
                    <div class="section-inherited-layer">
                      <p class="agent-instructions-empty">{t("agentSettings.section.none")}</p>
                      <Show when={current().sectionId}>
                        {(sectionId) => (
                          <Button size="sm" variant="secondary" onClick={() => props.onEditSection(sectionId())}>
                            {t("agentSettings.section.edit", { folder: folder() })}
                          </Button>
                        )}
                      </Show>
                    </div>
                  }
                >
                  <For each={shared()}>
                    {(layer) => (
                      <InheritedLayer
                        layer={layer}
                        optOut={current().optOut}
                        saving={saving()}
                        openLink={props.calls.openLink}
                        onEdit={() => props.onEditSection(layer.sectionId)}
                        onSetUsed={(kind, id, used) => void setUsed(kind, id, used)}
                      />
                    )}
                  </For>
                </Show>
              </>
            )}
          </Show>
          <Show when={error()}>
            {(message) => (
              <p class="ui-field-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </div>
      </SettingsPanelContent>
    </div>
  );
}

function InheritedLayer(props: {
  layer: InheritedSectionLayer;
  optOut: AgentSectionInheritance["optOut"];
  saving: string | null;
  openLink: (url: string) => void;
  onEdit: () => void;
  onSetUsed: (kind: "skill" | "mcp", id: string, used: boolean) => void;
}): JSX.Element {
  const { t } = useText();
  const folder = () => props.layer.path.join(" / ");
  return (
    <section class="section-inherited-layer">
      <div class="section-inherited-bar">
        <Badge variant="info-light">{folder()}</Badge>
        <span class="section-inherited-readonly">{t("agentSettings.section.readOnly")}</span>
        <Button size="sm" variant="secondary" onClick={props.onEdit}>
          {t("agentSettings.section.edit", { folder: props.layer.path.at(-1) ?? folder() })}
        </Button>
      </div>
      <Show when={props.layer.instructions.trim()}>
        {(body) => (
          <>
            <h4 class="section-inherited-heading">{t("agentSettings.section.instructions")}</h4>
            <div class="agent-instructions-text message-markdown">
              <MarkdownMessageText
                imagesAsLinks
                linkFavicons={false}
                body={body()}
                agents={[]}
                onSelectAgent={() => undefined}
                onOpenLink={props.openLink}
              />
            </div>
          </>
        )}
      </Show>
      <Show when={props.layer.skills.length > 0}>
        <h4 class="section-inherited-heading">{t("agentSettings.section.skills")}</h4>
        <ItemList
          kind="skill"
          items={props.layer.skills}
          optedOut={props.optOut.skillIds}
          saving={props.saving}
          onSetUsed={props.onSetUsed}
        />
      </Show>
      <Show when={props.layer.mcpServers.length > 0}>
        <h4 class="section-inherited-heading">{t("agentSettings.section.mcpServers")}</h4>
        <ItemList
          kind="mcp"
          items={props.layer.mcpServers}
          optedOut={props.optOut.mcpServerIds}
          saving={props.saving}
          onSetUsed={props.onSetUsed}
        />
      </Show>
    </section>
  );
}

function ItemList(props: {
  kind: "skill" | "mcp";
  items: InheritedSectionLayer["skills"];
  optedOut: readonly string[];
  saving: string | null;
  onSetUsed: (kind: "skill" | "mcp", id: string, used: boolean) => void;
}): JSX.Element {
  const { t } = useText();
  return (
    <ul class="section-inherited-items">
      <For each={props.items}>
        {(item) => (
          <li class="agent-settings-switch-row">
            <span class="section-inherited-item">
              <span class="settings-link-label">{item.name}</span>
              <Show when={item.description}>
                {(description) => <span class="section-inherited-item-description">{description()}</span>}
              </Show>
            </span>
            <Switch
              size="sm"
              aria-label={t("agentSettings.section.use", { name: item.name })}
              checked={!props.optedOut.includes(item.id)}
              disabled={props.saving !== null}
              onChange={(checked) => props.onSetUsed(props.kind, item.id, checked)}
            />
          </li>
        )}
      </For>
    </ul>
  );
}
