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
import {
  Button,
  Field,
  Input,
  KeyRound,
  Lock,
  NativeSelect,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
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
  /** Absent for a secret field: the host never keeps its value. */
  value?: string;
}

/** A secret in an answered form. Always eight dots, so the card does not tell the length of the secret. */
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

/**
 * The answer of a form that asked for a secret: one row for each field with a value, and one for
 * each secret field, which shows as hidden.
 */
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

/** The key before the title of an answered form that asked for a secret. */
function SecretFormIcon(props: { shown: boolean }) {
  return (
    <Show when={props.shown}>
      <span class="ui-block-icon integration-logo-tile" aria-hidden="true">
        <KeyRound />
      </span>
    </Show>
  );
}

/**
 * A choice field as a small select at the start of the footer, next to the submit button. A required
 * field cannot go back to no value.
 */
function FooterSelect(props: {
  field: UiFormOptionsField;
  value: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useText();
  return (
    <Select<string>
      class="ui-block-footer-select"
      options={props.field.options}
      value={props.value === "" ? null : props.value}
      disabled={props.disabled}
      disallowEmptySelection={props.field.required === true}
      placeholder={props.field.required ? t("uiBlock.form.choose") : t("uiBlock.form.notSet")}
      validationState={props.invalid ? "invalid" : "valid"}
      sameWidth={false}
      placement="bottom-start"
      onChange={(value) => props.onChange(value ?? "")}
      itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{itemProps.item.rawValue}</SelectItem>}
    >
      <SelectTrigger aria-label={fieldLabel(props.field)} size="sm">
        <SelectValue<string>>{(selection) => selection.selectedOption()}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

export interface UiFormBlockProps extends UiBlockProps<UiFormSpec> {
  /** The id of a select or segmented field that the footer shows as a small select, not the form. */
  footerFieldId?: string | undefined;
}

export function UiFormBlock(props: UiFormBlockProps) {
  const { t } = useText();
  const formId = createUniqueId();
  const state = () => uiBlockState(props);
  const frozen = () => state().status !== "pending";
  const locked = () => frozen() || props.disabled === true || props.busy === true;

  const [draft, setDraft] = createSignal<Record<string, string>>(
    Object.fromEntries(props.spec.fields.map((field) => [field.id, field.value ?? ""])),
  );
  const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set());
  // The answer did not pass the block's checks, such as a date that is not a real date.
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

  // A frozen block shows the stored answer; an open one shows what the person has typed.
  const currentValue = (field: UiFormField): string => {
    const stored = frozen() ? state().response?.values?.[field.id] : undefined;
    return typeof stored === "string" ? stored : (draft()[field.id] ?? "");
  };
  // An answered form that asked for a secret shows its answer as rows, not as disabled inputs.
  const summarized = () => state().status === "answered" && props.spec.fields.some(isSecretFormField);
  const answerRows = (): AnswerRow[] =>
    props.spec.fields.flatMap((field): AnswerRow[] => {
      if (isSecretFormField(field)) return [{ field }];
      const value = state().response?.values?.[field.id];
      return typeof value === "string" && value.trim() !== "" ? [{ field, value }] : [];
    });
  // The rows already show each answer, so the line under them would repeat it.
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
  const footerField = (): UiFormOptionsField | undefined =>
    props.spec.fields.find(
      (field): field is UiFormOptionsField =>
        field.id === props.footerFieldId && (field.kind === "select" || field.kind === "segmented"),
    );
  const bodyFields = () => props.spec.fields.filter((field) => field !== footerField());
  /** The error of the field in the footer goes to the error line of the card: the select has no room for it. */
  const cardError = (): string | undefined => {
    if (rejected()) return t("uiBlock.form.invalid");
    const field = footerField();
    return (field && errorOf(field)) ?? props.error;
  };

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

  function footerSelectOrNone(): JSX.Element | undefined {
    const field = footerField();
    if (!field) return undefined;
    return (
      <FooterSelect
        field={field}
        value={currentValue(field)}
        disabled={locked()}
        invalid={errorOf(field) !== undefined}
        onChange={(value) => setValue(field, value)}
      />
    );
  }

  return (
    <UiBlockCard
      class={cx("ui-block-form", props.class)}
      title={props.spec.title}
      icon={<SecretFormIcon shown={summarized()} />}
      status={state().status}
      outcome={outcome()}
      busy={props.busy}
      waiting={props.disabled !== true}
      error={cardError()}
      onSkip={props.disabled ? undefined : props.onSkip}
      footerStart={footerSelectOrNone()}
      actions={
        // The button is outside the form, in the footer of the card, so it names the form it sends.
        <Button type="submit" size="sm" form={formId} disabled={locked()}>
          {props.spec.submit ?? t("uiBlock.form.submit")}
        </Button>
      }
      elementRef={props.elementRef}
      hints={props.spec.hints}
      renderMarkdown={props.renderMarkdown}
    >
      <Show when={!summarized()} fallback={<FormAnswerRows rows={answerRows()} />}>
        <form
          id={formId}
          class="ui-block-form-fields"
          novalidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <For each={bodyFields()}>
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
