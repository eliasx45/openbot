import {
  channelWebhookUrlProblem,
  type ChannelWebhookSettings as Settings,
} from "@openbot/contracts/fork-channel-webhooks";
import { Button, Input, SwitchField } from "@openbot/ui";
import { SettingsField } from "@openbot/ui/components/SettingsPanel";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createStore, Show, untrack } from "solid-js";
import type { ChannelWebhooksApi } from "./channels-port";

export function ChannelWebhookSettings(props: { channelId: string; api: ChannelWebhooksApi; disabled: boolean }) {
  const { t, errorMessage } = useText();
  const [saved, setSaved] = createSignal<Settings | null>(null);
  const [form, setForm] = createStore({ url: "", secret: "", enabled: false });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);
  let generation = 0;

  function show(settings: Settings): void {
    setSaved(settings);
    setForm((state) => {
      state.url = settings.url;
      state.secret = "";
      state.enabled = settings.enabled;
    });
  }

  createEffect(
    () => props.channelId,
    (channelId) => {
      const current = ++generation;
      setError(null);
      setDone(false);
      untrack(() => props.api)
        .read(channelId)
        .then(
          (settings) => {
            if (current === generation) show(settings);
          },
          (failure: unknown) => {
            if (current === generation) setError(errorMessage(failure, t("channel.webhook.loadFailed")));
          },
        );
    },
  );

  const problem = () => {
    const url = form.url.trim();
    return url && channelWebhookUrlProblem(url) !== null;
  };
  const changed = () => {
    const current = saved();
    return !current || form.url.trim() !== current.url || form.enabled !== current.enabled || form.secret.length > 0;
  };

  async function save(secret?: string | null): Promise<void> {
    if (busy()) return;
    if (problem()) {
      setError(t("channel.webhook.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    setDone(false);
    const channelId = props.channelId;
    try {
      const url = form.url.trim();
      const next = await props.api.save({
        channelId,
        url,
        enabled: url !== "" && form.enabled,
        ...(secret !== undefined ? { secret } : form.secret ? { secret: form.secret } : {}),
      });
      if (channelId !== props.channelId) return;
      show(next);
      setDone(true);
    } catch (failure) {
      setError(errorMessage(failure, t("channel.webhook.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="channel-webhook" aria-label={t("channel.webhook.title")}>
      <h3 class="channel-members-title">{t("channel.webhook.title")}</h3>
      <p class="channel-members-note">{t("channel.webhook.description")}</p>
      <SettingsField label={t("channel.webhook.url")}>
        <Input
          type="url"
          aria-label={t("channel.webhook.url")}
          placeholder={t("channel.webhook.urlPlaceholder")}
          value={form.url}
          disabled={props.disabled || busy()}
          invalid={Boolean(problem())}
          onValueChange={(url) => {
            setDone(false);
            setForm((state) => {
              state.url = url;
            });
          }}
        />
      </SettingsField>
      <SettingsField label={t("channel.webhook.secret")}>
        <Input
          type="password"
          autocomplete="off"
          aria-label={t("channel.webhook.secret")}
          placeholder={saved()?.hasSecret ? t("channel.webhook.secretSaved") : t("channel.webhook.secretPlaceholder")}
          value={form.secret}
          disabled={props.disabled || busy()}
          onValueChange={(secret) => {
            setDone(false);
            setForm((state) => {
              state.secret = secret;
            });
          }}
        />
      </SettingsField>
      <SwitchField
        checked={form.enabled}
        disabled={props.disabled || busy() || form.url.trim() === ""}
        onChange={(enabled) => {
          setDone(false);
          setForm((state) => {
            state.enabled = enabled;
          });
        }}
        label={t("channel.webhook.enabled")}
        description={t("channel.webhook.enabledDescription")}
      />
      <div class="channel-webhook-actions">
        <Show when={saved()?.hasSecret}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={props.disabled || busy()}
            onClick={() => void save(null)}
          >
            {t("channel.webhook.removeSecret")}
          </Button>
        </Show>
        <Button type="button" size="sm" disabled={props.disabled || busy() || !changed()} onClick={() => void save()}>
          {t("channel.webhook.save")}
        </Button>
      </div>
      <Show when={error()}>
        {(message) => (
          <p class="channel-members-note" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={done() && !error()}>
        <p class="channel-members-note" role="status">
          {t("channel.webhook.saved")}
        </p>
      </Show>
    </section>
  );
}
