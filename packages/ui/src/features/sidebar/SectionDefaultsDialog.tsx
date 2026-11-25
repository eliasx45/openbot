import {
  SECTION_DEFAULTS_LIMITS,
  type SectionDefaultsChoice,
  type SectionDefaultsEditor,
  type UpdateSectionDefaultsInput,
} from "@openbot/contracts/fork-section-defaults";
import { Badge, Button, Checkbox, Dialog, Field, Input, Textarea } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { useText } from "../../text";

export interface SectionDefaultsCalls {
  load: (sectionId: string) => Promise<SectionDefaultsEditor>;
  save: (input: UpdateSectionDefaultsInput) => Promise<SectionDefaultsEditor>;
}

export function SectionDefaultsDialog(props: {
  sectionId: string;
  calls: SectionDefaultsCalls;
  onClose: () => void;
}): JSX.Element {
  const { t, errorMessage } = useText();
  const [editor, setEditor] = createSignal<SectionDefaultsEditor | null>(null);
  const [instructions, setInstructions] = createSignal("");
  const [skillIds, setSkillIds] = createSignal<string[]>([]);
  const [mcpServerIds, setMcpServerIds] = createSignal<string[]>([]);
  const [filter, setFilter] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  onSettled(() => {
    props.calls.load(props.sectionId).then(
      (loaded) => {
        setEditor(loaded);
        setInstructions(loaded.defaults.instructions);
        setSkillIds(loaded.defaults.skillIds);
        setMcpServerIds(loaded.defaults.mcpServerIds);
      },
      (failure: unknown) => setError(errorMessage(failure, t("sidebar.sectionDefaults.loadFailed"))),
    );
  });

  const folder = () => editor()?.path.join(" / ") ?? "";
  const shownSkills = createMemo(() => {
    const choices = editor()?.skillChoices ?? [];
    const query = filter().trim().toLocaleLowerCase();
    if (!query) return choices;
    return choices.filter(
      (choice) =>
        skillIds().includes(choice.id) ||
        choice.name.toLocaleLowerCase().includes(query) ||
        (choice.description ?? "").toLocaleLowerCase().includes(query),
    );
  });
  const toggle = (list: () => string[], set: (next: string[]) => void, id: string, on: boolean) =>
    set(on ? [...new Set([...list(), id])] : list().filter((candidate) => candidate !== id));

  async function save(): Promise<void> {
    if (saving() || !editor()) return;
    setSaving(true);
    setError(null);
    try {
      await props.calls.save({
        sectionId: props.sectionId,
        instructions: instructions(),
        skillIds: skillIds(),
        mcpServerIds: mcpServerIds(),
      });
      props.onClose();
    } catch (failure) {
      setError(errorMessage(failure, t("sidebar.sectionDefaults.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root
      open={true}
      onOpenChange={(open) => {
        if (!open && !saving()) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="section-defaults-backdrop">
          <Dialog.Content class="section-defaults-dialog" as="section">
            <header class="section-defaults-header">
              <Dialog.Title class="section-defaults-title">
                {t("sidebar.sectionDefaults.title", { folder: folder() })}
              </Dialog.Title>
              <Dialog.Description class="section-defaults-description">
                {t("sidebar.sectionDefaults.description")}
              </Dialog.Description>
            </header>
            <Show when={editor()}>
              {(loaded) => (
                <form
                  class="section-defaults-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <p class="section-defaults-members">
                    {loaded().members.length > 0
                      ? t("sidebar.sectionDefaults.members", {
                          names: loaded()
                            .members.map((member) => member.name)
                            .join(", "),
                        })
                      : t("sidebar.sectionDefaults.noMembers")}
                  </p>
                  <For each={loaded().parents.filter((layer) => sharesSomething(layer))}>
                    {(layer) => (
                      <div class="section-defaults-parent">
                        <Badge variant="info-light">
                          {t("sidebar.sectionDefaults.parent", { folder: layer.path.join(" / ") })}
                        </Badge>
                        <Show when={layer.instructions.trim()}>
                          <pre class="section-defaults-parent-text">{layer.instructions.trim()}</pre>
                        </Show>
                        <Show when={layer.skills.length + layer.mcpServers.length > 0}>
                          <p class="section-defaults-parent-list">
                            {[...layer.skills, ...layer.mcpServers].map((choice) => choice.name).join(", ")}
                          </p>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Field label={t("sidebar.sectionDefaults.instructions")}>
                    <Textarea
                      class="section-defaults-instructions"
                      value={instructions()}
                      maxlength={SECTION_DEFAULTS_LIMITS.instructions}
                      placeholder={t("sidebar.sectionDefaults.instructionsPlaceholder")}
                      onValueChange={setInstructions}
                    />
                  </Field>
                  <div class="section-defaults-group">
                    <div class="section-defaults-group-head">
                      <span class="section-defaults-group-title">{t("sidebar.sectionDefaults.skills")}</span>
                      <Show when={loaded().skillChoices.length > 8}>
                        <Input
                          size="sm"
                          class="section-defaults-filter"
                          aria-label={t("sidebar.sectionDefaults.filter")}
                          placeholder={t("sidebar.sectionDefaults.filter")}
                          value={filter()}
                          onValueChange={setFilter}
                        />
                      </Show>
                    </div>
                    <ChoiceList
                      choices={shownSkills()}
                      selected={skillIds()}
                      empty={t("sidebar.sectionDefaults.skillsEmpty")}
                      onToggle={(id, on) => toggle(skillIds, setSkillIds, id, on)}
                    />
                  </div>
                  <div class="section-defaults-group">
                    <div class="section-defaults-group-head">
                      <span class="section-defaults-group-title">{t("sidebar.sectionDefaults.mcpServers")}</span>
                    </div>
                    <p class="section-defaults-hint">{t("sidebar.sectionDefaults.mcpServersHint")}</p>
                    <ChoiceList
                      choices={loaded().mcpServerChoices}
                      selected={mcpServerIds()}
                      empty={t("sidebar.sectionDefaults.mcpServersEmpty")}
                      onToggle={(id, on) => toggle(mcpServerIds, setMcpServerIds, id, on)}
                    />
                  </div>
                  <footer class="section-defaults-actions">
                    <Button type="button" variant="ghost" disabled={saving()} onClick={props.onClose}>
                      {t("common.cancel")}
                    </Button>
                    <Button type="submit" loading={saving()} loadingLabel={t("common.saving")}>
                      {t("common.save")}
                    </Button>
                  </footer>
                </form>
              )}
            </Show>
            <Show when={error()}>
              {(message) => (
                <p class="ui-field-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function sharesSomething(layer: { instructions: string; skills: unknown[]; mcpServers: unknown[] }): boolean {
  return layer.instructions.trim().length > 0 || layer.skills.length > 0 || layer.mcpServers.length > 0;
}

function ChoiceList(props: {
  choices: readonly SectionDefaultsChoice[];
  selected: readonly string[];
  empty: string;
  onToggle: (id: string, on: boolean) => void;
}): JSX.Element {
  return (
    <Show when={props.choices.length > 0} fallback={<p class="section-defaults-hint">{props.empty}</p>}>
      <ul class="section-defaults-choices">
        <For each={props.choices}>
          {(choice) => (
            <li>
              <div class="section-defaults-choice">
                <Checkbox
                  id={`section-defaults-${choice.id}`}
                  checked={props.selected.includes(choice.id)}
                  onChange={(event) => props.onToggle(choice.id, event.currentTarget.checked)}
                />
                <label class="section-defaults-choice-text" for={`section-defaults-${choice.id}`}>
                  <span class="section-defaults-choice-name">{choice.name}</span>
                  <Show when={choice.description}>
                    {(description) => <span class="section-defaults-choice-description">{description()}</span>}
                  </Show>
                </label>
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
