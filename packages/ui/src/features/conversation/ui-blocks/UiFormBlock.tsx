import {
  isSecretFormField,
  UI_BLOCK_LIMITS,
  UI_BLOCK_SUBMIT_ACTION_ID,
  type UiBlockValue,
  type UiFormField,
  type UiFormOptionsField,
  type UiFormBlock as UiFormSpec,
  uiFormClipNotesKey,
  uiFormClipNoteValue,
  uiFormFieldTakesOther,
} from "@openbot/contracts/ui-blocks";
import { Button, Field, Input, KeyRound, Lock, NativeSelect, Textarea } from "@openbot/ui";
import { createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import { useText } from "../../../text";
import { cx } from "../../../utils";
import { UiBlockCard } from "./UiBlockCard";
import { UiFormClip } from "./UiFormClip";
import { UiMathText } from "./UiMathText";
import { sendUiBlockResponse, type UiBlockProps, uiBlockState } from "./ui-block-support";

/** Fork: the value of the "Other" entry of a select; never an option label, which cannot be blank-led. */
const OTHER_OPTION = "\u0000other";

function fieldLabel(field: UiFormField): string {
  return field.label ?? field.id;
}

interface AnswerRow {
  field: UiFormField;
  value?: string;
}

function HiddenValue() {
  const { t } = useText();
  return (
    <span class="ui-block-answer-hidden">
      <Lock aria-hidden="true" />
      <span aria-hidden="true">••••••••</span>
      <span class="sr-only">{t("uiBlock.form.hiddenValue")}</span>
    </span>
  );
}

function FormAnswerRows(props: { rows: AnswerRow[] }) {
  return (
    <dl class="ui-block-answer-rows">
      <For each={props.rows}>
        {(row) => (
          <div class="ui-block-answer-row">
            <dt>{fieldLabel(row.field)}</dt>
            <dd>
              <Show when={row.value} fallback={<HiddenValue />}>
                {(value) => <span class="ui-block-answer-value">{value()}</span>}
              </Show>
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
}

function SecretFormIcon(props: { shown: boolean }) {
  return (
    <Show when={props.shown}>
      <span class="ui-block-icon integration-logo-tile" aria-hidden="true">
        <KeyRound />
      </span>
    </Show>
  );
}

export function UiFormBlock(props: UiBlockProps<UiFormSpec>) {
  const { t } = useText();
  const formId = createUniqueId();
  const state = () => uiBlockState(props);
  const frozen = () => state().status !== "pending";
  const locked = () => frozen() || props.disabled === true || props.busy === true;

  const [draft, setDraft] = createSignal<Record<string, string>>(
    Object.fromEntries(props.spec.fields.map((field) => [field.id, field.value ?? ""])),
  );
  const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set());
  const [rejected, setRejected] = createSignal(false);
  // Fork (docs/fork/FEATURES.md, "Review cards"): the pause notes on each clip, and the fields where
  // the person chose Other.
  const [notes, setNotes] = createSignal<Record<string, string[]>>({});
  const [otherOpen, setOtherOpen] = createSignal<ReadonlySet<string>>(
    new Set(
      props.spec.fields.flatMap((field) =>
        (field.kind === "select" || field.kind === "segmented") &&
        field.value !== undefined &&
        !field.options.includes(field.value)
          ? [field.id]
          : [],
      ),
    ),
  );

  const currentValue = (field: UiFormField): string => {
    const stored = frozen() ? state().response?.values?.[field.id] : undefined;
    return typeof stored === "string" ? stored : (draft()[field.id] ?? "");
  };
  const summarized = () => state().status === "answered" && props.spec.fields.some(isSecretFormField);
  const shownFields = () =>
    frozen() && state().status !== "answered"
      ? props.spec.fields.filter((field) => !isSecretFormField(field))
      : props.spec.fields;
  const answerRows = (): AnswerRow[] =>
    props.spec.fields.flatMap((field): AnswerRow[] => {
      if (isSecretFormField(field)) return [{ field }];
      const value = state().response?.values?.[field.id];
      return typeof value === "string" && value.trim() !== "" ? [{ field, value }] : [];
    });
  const outcome = () => (summarized() ? undefined : state().outcome);
  const fieldNotes = (field: UiFormField): readonly string[] => {
    const key = uiFormClipNotesKey(field.id);
    const stored = frozen() ? state().response?.values?.[key] : undefined;
    return frozen() ? (Array.isArray(stored) ? stored : []) : (notes()[key] ?? []);
  };
  const isOther = (field: UiFormOptionsField): boolean =>
    otherOpen().has(field.id) ||
    (frozen() && currentValue(field) !== "" && !field.options.includes(currentValue(field)));
  function chooseOther(field: UiFormOptionsField, open: boolean): void {
    setOtherOpen((current) => {
      const next = new Set(current);
      if (open) next.add(field.id);
      else next.delete(field.id);
      return next;
    });
    if (open && field.options.includes(currentValue(field))) setValue(field, "");
  }
  function chooseOption(field: UiFormOptionsField, value: string): void {
    chooseOther(field, false);
    setValue(field, value);
  }
  const errorOf = (field: UiFormField) => (failed().has(field.id) ? t("uiBlock.form.required") : undefined);
  const cardError = (): string | undefined => (rejected() ? t("uiBlock.form.invalid") : props.error);

  function setValue(field: UiFormField, value: string): void {
    setDraft((current) => ({ ...current, [field.id]: value }));
    setRejected(false);
    if (failed().has(field.id) && value.trim() !== "") {
      setFailed((current) => new Set([...current].filter((id) => id !== field.id)));
    }
  }

  function submit(): void {
    if (locked()) return;
    const missing = props.spec.fields.filter((field) => field.required === true && currentValue(field).trim() === "");
    setFailed(new Set(missing.map((field) => field.id)));
    if (missing.length > 0) return;
    const values: Record<string, UiBlockValue> = {};
    for (const field of props.spec.fields) {
      const value = currentValue(field);
      if (value.trim() !== "") values[field.id] = field.kind === "date" ? value.trim() : value;
      const fieldNoteValues = field.clip ? notes()[uiFormClipNotesKey(field.id)] : undefined;
      if (fieldNoteValues?.length) values[uiFormClipNotesKey(field.id)] = [...fieldNoteValues];
    }
    setRejected(!sendUiBlockResponse(props.spec, { actionId: UI_BLOCK_SUBMIT_ACTION_ID, values }, props.onRespond));
  }

  return (
    <UiBlockCard
      class={cx("ui-block-form", props.class)}
      title={props.spec.title}
      icon={<SecretFormIcon shown={props.spec.fields.some(isSecretFormField)} />}
      status={state().status}
      outcome={outcome()}
      busy={props.busy}
      waiting={props.disabled !== true}
      error={cardError()}
      onSkip={props.disabled ? undefined : props.onSkip}
      actions={
        <Button type="submit" size="sm" form={formId} disabled={locked()}>
          {props.spec.submit ?? t("uiBlock.form.submit")}
        </Button>
      }
      elementRef={props.elementRef}
      hints={props.spec.hints}
      media={props.spec.media}
      renderMarkdown={props.renderMarkdown}
    >
      <Show
        when={!summarized() && shownFields().length > 0}
        fallback={summarized() ? <FormAnswerRows rows={answerRows()} /> : undefined}
      >
        <form
          id={formId}
          class="ui-block-form-fields"
          novalidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <For each={shownFields()}>
            {(field) => (
              <>
                <Show when={field.clip}>
                  {(clip) => (
                    <UiFormClip
                      clip={clip()}
                      notes={fieldNotes(field)}
                      locked={locked()}
                      onAdd={(time, text) =>
                        setNotes((current) => ({
                          ...current,
                          [uiFormClipNotesKey(field.id)]: [
                            ...(current[uiFormClipNotesKey(field.id)] ?? []),
                            uiFormClipNoteValue(time, text),
                          ],
                        }))
                      }
                      onRemove={(index) =>
                        setNotes((current) => ({
                          ...current,
                          [uiFormClipNotesKey(field.id)]: (current[uiFormClipNotesKey(field.id)] ?? []).filter(
                            (_note, at) => at !== index,
                          ),
                        }))
                      }
                    />
                  )}
                </Show>
                <Switch>
                  <Match when={field.kind === "segmented" ? field : undefined}>
                    {(segmented) => (
                      <fieldset class="ui-block-field" data-invalid={errorOf(field) ? "" : undefined}>
                        <legend class="ui-block-field-label">
                          <UiMathText text={fieldLabel(field)} />
                          <Show when={field.required}>
                            <span class="ui-block-required" aria-hidden="true">
                              *
                            </span>
                          </Show>
                        </legend>
                        <div class="ui-block-segmented">
                          <For each={segmented().options}>
                            {(option) => (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                class="ui-block-segment"
                                aria-pressed={
                                  !isOther(segmented()) && currentValue(field) === option ? "true" : "false"
                                }
                                disabled={locked()}
                                onClick={() =>
                                  chooseOption(
                                    segmented(),
                                    currentValue(field) === option && field.required !== true ? "" : option,
                                  )
                                }
                              >
                                <UiMathText text={option} />
                              </Button>
                            )}
                          </For>
                          <Show when={uiFormFieldTakesOther(segmented())}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              class="ui-block-segment"
                              aria-pressed={isOther(segmented()) ? "true" : "false"}
                              disabled={locked()}
                              onClick={() => chooseOther(segmented(), !isOther(segmented()))}
                            >
                              {t("uiBlock.form.other")}
                            </Button>
                          </Show>
                        </div>
                        <Show when={isOther(segmented())}>
                          <Input
                            value={currentValue(field)}
                            maxlength={UI_BLOCK_LIMITS.fieldValue}
                            placeholder={t("uiBlock.form.otherPlaceholder")}
                            aria-label={`${fieldLabel(field)}: ${t("uiBlock.form.other")}`}
                            disabled={locked()}
                            onValueChange={(value) => setValue(field, value)}
                          />
                        </Show>
                        <Show when={errorOf(field)}>
                          {(message) => (
                            <p class="ui-block-field-error" role="alert">
                              {message()}
                            </p>
                          )}
                        </Show>
                      </fieldset>
                    )}
                  </Match>
                  <Match when={true}>
                    <Field
                      label={<UiMathText text={fieldLabel(field)} />}
                      required={field.required === true}
                      error={errorOf(field)}
                    >
                      <Switch>
                        <Match when={field.kind === "textarea"}>
                          <Textarea
                            value={currentValue(field)}
                            maxlength={UI_BLOCK_LIMITS.fieldValue}
                            placeholder={"placeholder" in field ? field.placeholder : undefined}
                            disabled={locked()}
                            onValueChange={(value) => setValue(field, value)}
                          />
                        </Match>
                        <Match when={field.kind === "select" ? field : undefined}>
                          {(select) => (
                            <>
                              <NativeSelect
                                value={isOther(select()) ? OTHER_OPTION : currentValue(field)}
                                disabled={locked()}
                                onChange={(event) =>
                                  event.currentTarget.value === OTHER_OPTION
                                    ? chooseOther(select(), true)
                                    : chooseOption(select(), event.currentTarget.value)
                                }
                              >
                                <option value="">
                                  {field.required ? t("uiBlock.form.choose") : t("uiBlock.form.notSet")}
                                </option>
                                <For each={select().options}>
                                  {(option) => <option value={option}>{option}</option>}
                                </For>
                                <Show when={uiFormFieldTakesOther(select())}>
                                  <option value={OTHER_OPTION}>{t("uiBlock.form.other")}</option>
                                </Show>
                              </NativeSelect>
                              <Show when={isOther(select())}>
                                <Input
                                  value={currentValue(field)}
                                  maxlength={UI_BLOCK_LIMITS.fieldValue}
                                  placeholder={t("uiBlock.form.otherPlaceholder")}
                                  aria-label={`${fieldLabel(field)}: ${t("uiBlock.form.other")}`}
                                  disabled={locked()}
                                  onValueChange={(value) => setValue(field, value)}
                                />
                              </Show>
                            </>
                          )}
                        </Match>
                        <Match when={field.kind === "date"}>
                          <Input
                            type="date"
                            value={currentValue(field)}
                            disabled={locked()}
                            onValueChange={(value) => setValue(field, value)}
                          />
                        </Match>
                        <Match when={true}>
                          <Input
                            type={isSecretFormField(field) ? "password" : "text"}
                            autocomplete={isSecretFormField(field) ? "off" : undefined}
                            value={currentValue(field)}
                            maxlength={UI_BLOCK_LIMITS.fieldValue}
                            placeholder={"placeholder" in field ? field.placeholder : undefined}
                            disabled={locked()}
                            onValueChange={(value) => setValue(field, value)}
                          />
                        </Match>
                      </Switch>
                    </Field>
                  </Match>
                </Switch>
              </>
            )}
          </For>
        </form>
      </Show>
    </UiBlockCard>
  );
}
