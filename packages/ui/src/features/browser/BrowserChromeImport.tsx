// Fork (docs/fork/FEATURES.md entry 32): "Import from Chrome" in the browser profiles of this computer.
// Each selected Chrome profile becomes a named browser profile; its sites are all, or the ones selected.

import type {
  ChromeImportResult,
  ChromeProfileList,
  ChromeSite,
  ImportChromeProfilesInput,
} from "@openbot/contracts/ipc";
import {
  Button,
  Checkbox,
  ErrorReference,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Text,
} from "@openbot/ui";
import { errorReference, type UserErrorDetails } from "@openbot/user-errors";
import { createMemo, createSignal, createStore, For, Show } from "solid-js";
import { useText } from "../../text";

export interface BrowserChromeImportCalls {
  listProfiles(): Promise<ChromeProfileList>;
  listSites(chromeDir: string): Promise<ChromeSite[]>;
  importProfiles(input: ImportChromeProfilesInput): Promise<ChromeImportResult>;
}

export interface BrowserChromeImportProps {
  calls: BrowserChromeImportCalls;
  /** Runs after an import, so the profile list reads the new profiles. */
  onImported: (result: ChromeImportResult) => void;
  disabled?: boolean;
}

interface ImportDraft {
  open: boolean;
  list: ChromeProfileList | null;
  query: string;
  picked: string[];
  /** False: all sites. True: the sites shown, less the ones in `excluded`. */
  someSites: boolean;
  /** The Chrome profile whose sites show. */
  sitesOf: string | null;
  sites: Record<string, ChromeSite[]>;
  excluded: Record<string, string[]>;
  busy: boolean;
  done: string | null;
  failure: UserErrorDetails | null;
}

/** A stable element id for a checkbox and its label. */
function controlId(kind: string, value: string): string {
  return `browser-chrome-${kind}-${value.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

export function BrowserChromeImport(props: BrowserChromeImportProps) {
  const { t, errorMessage } = useText();
  const [draft, setDraft] = createStore<ImportDraft>({
    open: false,
    list: null,
    query: "",
    picked: [],
    someSites: false,
    sitesOf: null,
    sites: {},
    excluded: {},
    busy: false,
    done: null,
    failure: null,
  });
  const [loadingSites, setLoadingSites] = createSignal(false);

  function fail(error: unknown): void {
    setDraft((state) => {
      state.failure = { message: errorMessage(error, t("browser.chrome.failed")), reference: errorReference(error) };
    });
  }

  async function open(): Promise<void> {
    setDraft((state) => {
      state.open = true;
      state.done = null;
      state.failure = null;
    });
    if (draft.list) return;
    try {
      const list = await props.calls.listProfiles();
      setDraft((state) => {
        state.list = list;
      });
    } catch (error) {
      fail(error);
    }
  }

  const shown = createMemo(() => {
    const query = draft.query.trim().toLowerCase();
    const profiles = draft.list?.profiles ?? [];
    return query ? profiles.filter((p) => `${p.browser} ${p.name} ${p.email}`.toLowerCase().includes(query)) : profiles;
  });

  async function showSites(dir: string): Promise<void> {
    setDraft((state) => {
      state.sitesOf = dir;
    });
    if (draft.sites[dir]) return;
    setLoadingSites(true);
    try {
      const sites = await props.calls.listSites(dir);
      setDraft((state) => {
        state.sites[dir] = sites;
      });
    } catch (error) {
      fail(error);
    } finally {
      setLoadingSites(false);
    }
  }

  function toggle(dir: string): void {
    const picking = !draft.picked.includes(dir);
    setDraft((state) => {
      state.picked = picking ? [...state.picked, dir] : state.picked.filter((entry) => entry !== dir);
      if (!picking && state.sitesOf === dir) state.sitesOf = state.picked[0] ?? null;
    });
    if (picking && draft.someSites && !draft.sitesOf) void showSites(dir);
  }

  function setSomeSites(some: boolean): void {
    setDraft((state) => {
      state.someSites = some;
    });
    const first = draft.picked[0];
    if (some && first && !draft.sitesOf) void showSites(first);
  }

  function toggleSite(dir: string, site: string): void {
    setDraft((state) => {
      const current = state.excluded[dir] ?? [];
      state.excluded[dir] = current.includes(site) ? current.filter((entry) => entry !== site) : [...current, site];
    });
  }

  async function run(): Promise<void> {
    if (!draft.picked.length || draft.busy) return;
    setDraft((state) => {
      state.busy = true;
      state.failure = null;
    });
    try {
      const input: ImportChromeProfilesInput = {
        profiles: draft.picked.map((dir) => {
          if (!draft.someSites) return { dir, sites: null };
          const all = draft.sites[dir];
          const left = draft.excluded[dir] ?? [];
          // Sites never shown are all kept.
          return { dir, sites: all ? all.map((entry) => entry.site).filter((site) => !left.includes(site)) : null };
        }),
      };
      const result = await props.calls.importProfiles(input);
      setDraft((state) => {
        state.open = false;
        state.picked = [];
        state.done = t("browser.chrome.imported", { count: result.profiles.length });
      });
      props.onImported(result);
    } catch (error) {
      fail(error);
    } finally {
      setDraft((state) => {
        state.busy = false;
      });
    }
  }

  const profileName = (dir: string | null) => draft.list?.profiles.find((profile) => profile.dir === dir)?.name ?? "";

  return (
    <div class="browser-chrome-import">
      <Show
        when={draft.open}
        fallback={
          <div class="browser-profiles-row">
            <Button variant="outline" disabled={props.disabled} onClick={() => void open()}>
              {t("browser.chrome.import")}
            </Button>
            <Show when={draft.done}>{(done) => <Text variant="caption">{done()}</Text>}</Show>
          </div>
        }
      >
        <section class="browser-chrome-import-sheet" aria-label={t("browser.chrome.import")}>
          <Show when={draft.list} fallback={<Text variant="caption">{t("browser.chrome.loading")}</Text>}>
            {(list) => (
              <Show when={list().available} fallback={<Text variant="caption">{t("browser.chrome.unavailable")}</Text>}>
                <Text variant="caption" class="browser-chrome-import-label">
                  {t("browser.chrome.profilesLabel")}
                </Text>
                <Input
                  value={draft.query}
                  aria-label={t("browser.chrome.search", { count: list().profiles.length })}
                  placeholder={t("browser.chrome.search", { count: list().profiles.length })}
                  onValueChange={(value) =>
                    setDraft((state) => {
                      state.query = value;
                    })
                  }
                />
                <ItemGroup class="settings-modal-card browser-chrome-import-list" surface="subtle">
                  <For each={shown()}>
                    {(profile) => (
                      <Item>
                        <Checkbox
                          id={controlId("profile", profile.dir)}
                          checked={draft.picked.includes(profile.dir)}
                          disabled={draft.busy}
                          onChange={() => toggle(profile.dir)}
                        />
                        <label class="browser-chrome-import-pick" for={controlId("profile", profile.dir)}>
                          <ItemContent>
                            <ItemTitle>{profile.name}</ItemTitle>
                            <ItemDescription>
                              {profile.browser} · {profile.email || t("browser.chrome.noAccount")}
                            </ItemDescription>
                          </ItemContent>
                        </label>
                        <ItemActions>
                          <Text variant="caption">{t("browser.chrome.cookies", { count: profile.cookies })}</Text>
                        </ItemActions>
                      </Item>
                    )}
                  </For>
                </ItemGroup>
                <Text variant="caption">{t("browser.chrome.hint")}</Text>

                <Text variant="caption" class="browser-chrome-import-label">
                  {t("browser.chrome.sitesLabel")}
                </Text>
                <fieldset
                  class="browser-profiles-row browser-chrome-import-choice"
                  aria-label={t("browser.chrome.sitesLabel")}
                >
                  <Button
                    size="sm"
                    variant={draft.someSites ? "ghost" : "secondary"}
                    aria-pressed={!draft.someSites ? "true" : "false"}
                    onClick={() => setSomeSites(false)}
                  >
                    {t("browser.chrome.allSites")}
                  </Button>
                  <Button
                    size="sm"
                    variant={draft.someSites ? "secondary" : "ghost"}
                    aria-pressed={draft.someSites ? "true" : "false"}
                    onClick={() => setSomeSites(true)}
                  >
                    {t("browser.chrome.someSites")}
                  </Button>
                </fieldset>
                <Show when={draft.someSites && draft.picked.length > 0}>
                  <Show when={draft.picked.length > 1}>
                    <fieldset
                      class="browser-profiles-row browser-chrome-import-choice"
                      aria-label={t("browser.chrome.sitesLabel")}
                    >
                      <For each={draft.picked}>
                        {(dir) => (
                          <Button
                            size="sm"
                            variant={draft.sitesOf === dir ? "secondary" : "ghost"}
                            aria-pressed={draft.sitesOf === dir ? "true" : "false"}
                            onClick={() => void showSites(dir)}
                          >
                            {profileName(dir)}
                          </Button>
                        )}
                      </For>
                    </fieldset>
                  </Show>
                  <Show
                    when={draft.sitesOf ? draft.sites[draft.sitesOf] : undefined}
                    fallback={<Text variant="caption">{loadingSites() ? t("browser.chrome.sitesLoading") : ""}</Text>}
                  >
                    {(sites) => (
                      <ItemGroup
                        class="settings-modal-card browser-chrome-import-list"
                        surface="subtle"
                        aria-label={t("browser.chrome.sitesFor", { name: profileName(draft.sitesOf) })}
                      >
                        <For each={sites()}>
                          {(site) => (
                            <Item>
                              <Checkbox
                                id={controlId("site", site.site)}
                                checked={!(draft.excluded[draft.sitesOf ?? ""] ?? []).includes(site.site)}
                                disabled={draft.busy}
                                onChange={() => toggleSite(draft.sitesOf ?? "", site.site)}
                              />
                              <label class="browser-chrome-import-pick" for={controlId("site", site.site)}>
                                <ItemContent>
                                  <ItemTitle>{site.site}</ItemTitle>
                                </ItemContent>
                              </label>
                              <ItemActions>
                                <Text variant="caption">{t("browser.chrome.cookies", { count: site.cookies })}</Text>
                              </ItemActions>
                            </Item>
                          )}
                        </For>
                      </ItemGroup>
                    )}
                  </Show>
                </Show>
                <Text variant="caption">{t("browser.chrome.keychainHint")}</Text>
                <Text variant="caption">{t("browser.chrome.passwordsHint")}</Text>
                <div class="browser-profiles-row browser-chrome-import-actions">
                  <Button
                    variant="ghost"
                    disabled={draft.busy}
                    onClick={() =>
                      setDraft((state) => {
                        state.open = false;
                      })
                    }
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={draft.busy || draft.picked.length === 0}
                    loading={draft.busy}
                    loadingLabel={t("browser.chrome.importing")}
                    onClick={() => void run()}
                  >
                    {t("browser.chrome.importCount", { count: Math.max(draft.picked.length, 1) })}
                  </Button>
                </div>
              </Show>
            )}
          </Show>
        </section>
      </Show>
      <Show when={draft.failure}>
        {(failure) => (
          <Text tone="danger" variant="caption" role="alert">
            {failure().message}
            <ErrorReference reference={failure().reference} />
          </Text>
        )}
      </Show>
    </div>
  );
}
