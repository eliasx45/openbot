import { AppLogo, type AppLogoVariant, ProviderLogo } from "@openbot/brand";
import { usageTone } from "@openbot/team-client/plan-limits";
import {
  AppWindow,
  Bot,
  BriefcaseBusiness,
  Button,
  buttonVariants,
  CalendarClock,
  ChartArea,
  ContextMenu,
  DropdownMenu,
  Ellipsis,
  GalleryVerticalEnd,
  Gauge,
  ListChecks,
  MotionTooltip,
  Pin,
  PinOff,
  Plug,
  Settings,
  Sparkles,
  Store,
  Waypoints,
} from "@openbot/ui";
import { AccountUsageDetails, AccountUsageWindowList } from "@openbot/ui/features/account/AccountUsageDetails";
import type { AccountUsageProviderRow } from "@openbot/ui/features/account/account-usage-view";
import { useText } from "@openbot/ui/text";
import { Dynamic, type JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";

interface RailMenuItem {
  label: string;
  icon: typeof Bot;
  open: (button: HTMLElement) => void;
}

function RailContextMenu(props: {
  label: string;
  items: readonly RailMenuItem[];
  button: () => HTMLElement | undefined;
}) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content class="agent-context-menu" aria-label={props.label}>
        <For each={props.items}>
          {(item) => (
            <ContextMenu.Item
              onSelectAfterClose={() => {
                const button = props.button();
                if (button) item.open(button);
              }}
            >
              <Dynamic component={item.icon} class="agent-context-icon size-4" aria-hidden="true" />
              <span>{item.label}</span>
            </ContextMenu.Item>
          )}
        </For>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

function RailButton(props: {
  label: string;
  card?: () => JSX.Element;
  current?: boolean;
  class?: string;
  menu?: readonly RailMenuItem[] | undefined;
  onClick: (button: HTMLElement) => void;
  onPreload?: (() => void) | undefined;
  children: JSX.Element;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const plain = () => (
    <Button
      variant="ghost"
      type="button"
      class={props.class ? `window-rail-button ${props.class}` : "window-rail-button"}
      aria-label={props.label}
      aria-current={props.current ? "page" : undefined}
      onPointerEnter={() => props.onPreload?.()}
      onFocus={() => props.onPreload?.()}
      onClick={(event) => props.onClick(event.currentTarget)}
    >
      {props.children}
    </Button>
  );
  const button = () => (
    <Show when={props.menu} fallback={plain()}>
      {(items) => {
        let element: HTMLElement | undefined;
        return (
          <ContextMenu.Root modal={false} onOpenChange={setMenuOpen}>
            <ContextMenu.Trigger
              as="button"
              type="button"
              ref={(trigger: HTMLElement) => {
                element = trigger;
              }}
              class={`${buttonVariants({ variant: "ghost" })} window-rail-button`}
              aria-label={props.label}
              aria-current={props.current ? "page" : undefined}
              onPointerEnter={() => props.onPreload?.()}
              onFocus={() => props.onPreload?.()}
              onClick={(event: MouseEvent) => {
                if (event.currentTarget instanceof HTMLElement) props.onClick(event.currentTarget);
              }}
            >
              {props.children}
            </ContextMenu.Trigger>
            <RailContextMenu label={props.label} items={items()} button={() => element} />
          </ContextMenu.Root>
        );
      }}
    </Show>
  );
  return (
    <Show
      when={props.card}
      fallback={
        <MotionTooltip content={props.label} suppressed={menuOpen()}>
          {button()}
        </MotionTooltip>
      }
    >
      {(card) => (
        <MotionTooltip
          content={card()()}
          class="ui-popover-menu-surface account-usage-popover window-rail-usage-card"
          placement="right-end"
          openDelay={250}
          closeDelay={75}
        >
          {button()}
        </MotionTooltip>
      )}
    </Show>
  );
}

export interface CustomAgentUsageRailRow {
  id: string;
  name: string;
  text: string;
}

function UsageCardSummary(props: { children: JSX.Element }) {
  let summary: HTMLDivElement | undefined;
  const fit = () => {
    const card = summary?.parentElement;
    if (!summary || !card) return;
    card.style.removeProperty("width");
    const box = card.getBoundingClientRect();
    const scale = box.width / card.offsetWidth || 1;
    let right = 0;
    for (const child of summary.children) {
      if (child instanceof HTMLElement && child.tagName !== "HEADER")
        right = Math.max(right, (child.getBoundingClientRect().right - box.left) / scale);
    }
    const style = getComputedStyle(card);
    const width =
      Math.ceil(right + Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth)) + 1;
    if (right > 0 && width < card.offsetWidth) card.style.width = `${width}px`;
  };
  onSettled(() => {
    const element = summary;
    if (!element) return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  });
  return (
    <div class="window-rail-usage-summary" ref={(element) => (summary = element)}>
      {props.children}
    </div>
  );
}

function UsageButton(props: {
  rows: readonly AccountUsageProviderRow[];
  customAgents: readonly CustomAgentUsageRailRow[];
  onOpen: (button: HTMLElement) => void;
}) {
  const { t, format } = useText();
  const label = () => {
    const names = [...props.rows.map((row) => row.name), ...props.customAgents.map((row) => row.name)];
    if (props.rows.length === 0) return t("app.rail.customAgentUsage", { name: format.list(names) });
    return t("app.rail.usageRings", {
      name: format.list(names),
      windows: props.rows
        .flatMap((row) => row.windows)
        .map((window) =>
          t("account.usage.row.windowUsed", { window: window.label, percent: 100 - window.remainingPercent }),
        )
        .join(", "),
    });
  };
  /** One column per provider, in first-seen order; each column stacks that provider's accounts. */
  const groups = () => {
    const byProvider = new Map<string, AccountUsageProviderRow[]>();
    for (const row of props.rows) {
      const group = byProvider.get(row.provider);
      if (group) group.push(row);
      else byProvider.set(row.provider, [row]);
    }
    return [...byProvider.values()];
  };
  return (
    <RailButton
      label={label()}
      card={() => (
        <UsageCardSummary>
          <header class="account-usage-popover-header">
            <div class="account-usage-popover-heading">
              <Gauge aria-hidden="true" />
              <h2 class="account-usage-popover-title">{t("account.usage.title")}</h2>
            </div>
          </header>
          <For each={groups()} keyed={(group) => group[0]?.provider ?? ""}>
            {(group) => (
              <div class="window-rail-usage-column">
                <AccountUsageDetails
                  rows={[...group()]}
                  loading={false}
                  error={null}
                  refreshActive={false}
                  refreshDisabled
                  onRefresh={() => undefined}
                  title={null}
                />
              </div>
            )}
          </For>
          <For each={props.customAgents} keyed={(row) => row.id}>
            {(row) => (
              <div class="window-rail-agent-usage">
                <h2 class="account-usage-popover-title">{row().name}</h2>
                <p class="window-rail-agent-usage-text">{row().text}</p>
              </div>
            )}
          </For>
        </UsageCardSummary>
      )}
      onClick={props.onOpen}
    >
      <Gauge aria-hidden="true" />
    </RailButton>
  );
}

export interface MediaCreditsRailRow {
  key: string;
  provider: "sunra" | "higgsfield";
  name: string;
  available: number;
  quota: number | null;
  number?: number | undefined;
}

function mediaCreditsPercent(row: MediaCreditsRailRow): number {
  const quota = row.quota ?? 0;
  return quota > 0 ? Math.min(100, Math.round((row.available / quota) * 100)) : 0;
}

function mediaCreditsTone(row: MediaCreditsRailRow) {
  if (row.quota !== null) return usageTone(mediaCreditsPercent(row));
  return row.available > 0 ? "neutral" : "critical";
}

function MediaCreditsButton(props: { row: MediaCreditsRailRow; onOpen: (button: HTMLElement) => void }) {
  const { t, format } = useText();
  const percent = () => mediaCreditsPercent(props.row);
  const label = () => {
    const credits = format.number(props.row.available);
    const quota = props.row.quota;
    return quota !== null
      ? t("app.rail.mediaCreditsQuota", { name: props.row.name, credits, quota: format.number(quota) })
      : t("app.rail.mediaCredits", { name: props.row.name, credits });
  };
  return (
    <RailButton
      label={label()}
      card={() => (
        <ul class="account-usage-providers" aria-label={props.row.name}>
          <li class="account-usage-provider">
            <ProviderLogo provider={props.row.provider} class="account-usage-provider-logo" />
            <Show
              when={props.row.quota !== null}
              fallback={
                <>
                  <span class="account-usage-provider-copy">
                    <strong class="account-usage-provider-name">{props.row.name}</strong>
                    <span class="account-usage-provider-meta">{t("app.rail.mediaCreditsMeta")}</span>
                  </span>
                  <strong class="account-usage-provider-remaining">{format.number(props.row.available)}</strong>
                </>
              }
            >
              <strong class="account-usage-provider-name">{props.row.name}</strong>
              <AccountUsageWindowList
                windows={[
                  {
                    label: t("app.rail.mediaCreditsWindow", {
                      credits: format.number(props.row.available),
                      quota: format.number(props.row.quota ?? 0),
                    }),
                    remainingPercent: percent(),
                    tone: usageTone(percent()),
                    durationMins: null,
                    resetsAt: null,
                    resetsAtLabel: null,
                  },
                ]}
                now={Date.now()}
              />
            </Show>
          </li>
        </ul>
      )}
      class="window-rail-credits"
      onClick={props.onOpen}
    >
      <ProviderLogo provider={props.row.provider} class="window-rail-credits-logo" />
      <span class="window-rail-credits-count" data-usage-tone={mediaCreditsTone(props.row)} aria-hidden="true">
        {format.compact(props.row.available)}
      </span>
      <Show when={props.row.number}>
        {(number) => (
          <span class="window-rail-credits-badge" aria-hidden="true">
            {number()}
          </span>
        )}
      </Show>
    </RailButton>
  );
}

export type PageRailPage =
  | "agents"
  | "workflows"
  | "tasks"
  | "schedule"
  | "usage"
  | "library"
  | "providers"
  | "crm"
  | "apps" // Fork (docs/fork/FEATURES.md #123)
  | "marketplace"
  | "settings";

export const PAGE_RAIL_PINNABLE_PAGES = [
  "workflows",
  "tasks",
  "schedule",
  "usage",
  "library",
  "providers",
  "crm",
  "apps", // Fork (docs/fork/FEATURES.md #123)
] as const satisfies readonly PageRailPage[];
export type PageRailPinnablePage = (typeof PAGE_RAIL_PINNABLE_PAGES)[number];

export interface PageRailProps {
  hidden: boolean;
  current: PageRailPage | null;
  pinned: readonly PageRailPinnablePage[];
  onPinChange: (page: PageRailPinnablePage, pinned: boolean) => void;
  usageRows: readonly AccountUsageProviderRow[];
  customAgentUsage?: readonly CustomAgentUsageRailRow[] | undefined;
  mediaCredits?: readonly MediaCreditsRailRow[] | undefined;
  onMediaCredits?: ((provider: MediaCreditsRailRow["provider"]) => void) | undefined;
  onAgents: () => void;
  onWorkflows?: (() => void) | undefined;
  onPreloadWorkflows?: (() => void) | undefined;
  onTasks?: ((button: HTMLElement) => void) | undefined;
  onSchedule?: ((button: HTMLElement) => void) | undefined;
  onUsage: (button: HTMLElement) => void;
  onLibrary?: ((button: HTMLElement) => void) | undefined;
  onProviders?: ((button: HTMLElement) => void) | undefined;
  onCrm?: ((button: HTMLElement) => void) | undefined;
  onCrmConnectors?: ((button: HTMLElement) => void) | undefined;
  /** Fork (docs/fork/FEATURES.md #123): the saved apps page. */
  onApps?: ((button: HTMLElement) => void) | undefined;
  onMarketplace?: (() => void) | undefined;
  onSettings: (button: HTMLElement) => void;
  settingsNotice?: string | undefined;
  help: JSX.Element;
  server?: JSX.Element;
  logo?: { variant: AppLogoVariant; href?: string | undefined } | undefined;
}

interface RailPage {
  id: PageRailPinnablePage;
  label: string;
  icon: typeof Bot;
  open: (button: HTMLElement) => void;
  preload?: (() => void) | undefined;
  menu?: readonly RailMenuItem[] | undefined;
}

function RailMoreMenu(props: {
  pages: readonly RailPage[];
  current: PageRailPage | null;
  pinned: readonly PageRailPinnablePage[];
  onPinChange: (page: PageRailPinnablePage, pinned: boolean) => void;
}) {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLElement | undefined;
  let anchor: DOMRect | undefined;
  const changeOpen = (next: boolean) => {
    anchor = next ? trigger?.getBoundingClientRect() : undefined;
    setOpen(next);
  };
  const pinned = (page: PageRailPinnablePage) => props.pinned.includes(page);
  const currentInMenu = () => props.pages.some((page) => page.id === props.current && !pinned(page.id));
  return (
    <DropdownMenu.Root
      placement="right-start"
      gutter={10}
      onOpenChange={changeOpen}
      getAnchorRect={(element?: HTMLElement) => anchor ?? element?.getBoundingClientRect()}
    >
      <MotionTooltip content={t("app.rail.more")} suppressed={open()}>
        <DropdownMenu.Trigger
          ref={(element: HTMLElement) => {
            trigger = element;
          }}
          class="window-rail-button"
          aria-label={t("app.rail.more")}
          aria-current={currentInMenu() ? "page" : undefined}
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenu.Trigger>
      </MotionTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="agent-context-menu window-rail-more-menu" aria-label={t("app.rail.more")}>
          <For each={props.pages} keyed={(page) => page.id}>
            {(page) => (
              <div role="none" class="window-rail-more-row" data-pinned={pinned(page().id) ? "" : undefined}>
                <DropdownMenu.Item
                  onPointerEnter={() => page().preload?.()}
                  onFocus={() => page().preload?.()}
                  onSelectAfterClose={() => trigger && page().open(trigger)}
                >
                  <Dynamic component={page().icon} class="agent-context-icon size-4" aria-hidden="true" />
                  <span>{page().label}</span>
                </DropdownMenu.Item>
                <DropdownMenu.CheckboxItem
                  class="window-rail-more-pin"
                  closeOnSelect={false}
                  checked={pinned(page().id)}
                  onChange={(checked: boolean) => props.onPinChange(page().id, checked)}
                  aria-label={t("app.rail.pinPage", { name: page().label })}
                >
                  <Pin class="agent-context-icon size-4" aria-hidden="true" />
                </DropdownMenu.CheckboxItem>
              </div>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function RailLogo(props: { variant: AppLogoVariant; href: string | undefined }) {
  const { t } = useText();
  return (
    <div class="window-rail-logo">
      <Show when={props.href} fallback={<AppLogo variant={props.variant} />}>
        {(href) => (
          <MotionTooltip content={t("app.rail.website")}>
            <a
              class="window-rail-logo-link"
              href={href()}
              target="_blank"
              rel="noopener"
              aria-label={t("app.rail.website")}
            >
              <AppLogo variant={props.variant} />
            </a>
          </MotionTooltip>
        )}
      </Show>
    </div>
  );
}

export function PageRail(props: PageRailProps) {
  const { t } = useText();
  const usageRows = createMemo(() => props.usageRows.filter((row) => row.reportsUsage && row.windows.length > 0));
  const pages = createMemo((): RailPage[] => {
    const list: RailPage[] = [];
    const { onWorkflows, onTasks, onSchedule } = props;
    if (onWorkflows) {
      list.push({
        id: "workflows",
        label: t("app.rail.workflows"),
        icon: Waypoints,
        open: () => onWorkflows(),
        preload: props.onPreloadWorkflows,
      });
    }
    if (onTasks) {
      list.push({ id: "tasks", label: t("app.rail.tasks"), icon: ListChecks, open: onTasks });
    }
    if (onSchedule) {
      list.push({
        id: "schedule",
        label: t("app.rail.schedule"),
        icon: CalendarClock,
        open: onSchedule,
      });
    }
    list.push({ id: "usage", label: t("app.rail.usage"), icon: ChartArea, open: props.onUsage });
    const onLibrary = props.onLibrary;
    if (onLibrary) {
      list.push({ id: "library", label: t("app.rail.library"), icon: GalleryVerticalEnd, open: onLibrary });
    }
    const onProviders = props.onProviders;
    if (onProviders) {
      list.push({ id: "providers", label: t("app.rail.providers"), icon: Sparkles, open: onProviders });
    }
    const onCrm = props.onCrm;
    if (onCrm) {
      const onConnectors = props.onCrmConnectors;
      list.push({
        id: "crm",
        label: t("app.rail.crm"),
        icon: BriefcaseBusiness,
        open: onCrm,
        menu: onConnectors && [{ label: t("crm.connectors.title"), icon: Plug, open: onConnectors }],
      });
    }
    const onApps = props.onApps; // Fork (docs/fork/FEATURES.md #123)
    if (onApps) list.push({ id: "apps", label: t("app.rail.apps"), icon: AppWindow, open: onApps });
    return list;
  });
  return (
    <nav class="window-rail" aria-label={t("app.rail.label")} hidden={props.hidden}>
      <Show when={props.logo}>{(logo) => <RailLogo variant={logo().variant} href={logo().href} />}</Show>
      <div class="window-rail-group">
        <RailButton label={t("app.rail.agents")} current={props.current === "agents"} onClick={props.onAgents}>
          <Bot aria-hidden="true" />
        </RailButton>
        <For each={pages().filter((page) => props.pinned.includes(page.id))} keyed={(page) => page.id}>
          {(page) => (
            <RailButton
              label={page().label}
              current={props.current === page().id}
              menu={[
                ...(page().menu ?? []),
                { label: t("sidebar.unpin"), icon: PinOff, open: () => props.onPinChange(page().id, false) },
              ]}
              onClick={page().open}
              onPreload={page().preload}
            >
              <Dynamic component={page().icon} aria-hidden="true" />
            </RailButton>
          )}
        </For>
        <RailMoreMenu pages={pages()} current={props.current} pinned={props.pinned} onPinChange={props.onPinChange} />
      </div>
      <div class="window-rail-end">
        <div class="window-rail-group">
          <Show when={usageRows().length > 0 || (props.customAgentUsage?.length ?? 0) > 0}>
            <UsageButton rows={usageRows()} customAgents={props.customAgentUsage ?? []} onOpen={props.onUsage} />
          </Show>
          <For each={props.mediaCredits ?? []} keyed={(row) => row.key}>
            {(row) => <MediaCreditsButton row={row()} onOpen={() => props.onMediaCredits?.(row().provider)} />}
          </For>
          <Show when={props.onMarketplace}>
            {(onMarketplace) => (
              <RailButton
                label={t("app.rail.marketplace")}
                current={props.current === "marketplace"}
                onClick={() => onMarketplace()()}
              >
                <Store aria-hidden="true" />
              </RailButton>
            )}
          </Show>
          {props.help}
          <RailButton
            label={
              props.settingsNotice
                ? t("app.rail.settingsNotice", { notice: props.settingsNotice })
                : t("app.rail.settings")
            }
            current={props.current === "settings"}
            onClick={props.onSettings}
          >
            <Settings aria-hidden="true" />
            <Show when={props.settingsNotice}>
              <span class="window-rail-notice" aria-hidden="true" />
            </Show>
          </RailButton>
        </div>
        <div class="window-rail-server-slot">{props.server}</div>
      </div>
    </nav>
  );
}
