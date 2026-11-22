import { AppLogo, type AppLogoVariant, ProviderLogo } from "@openbot/brand";
import { usageTone } from "@openbot/team-client/plan-limits";
import {
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
  Workflow,
} from "@openbot/ui";
import { AccountUsageDetails, AccountUsageWindowList } from "@openbot/ui/features/account/AccountUsageDetails";
import type { AccountUsageProviderRow } from "@openbot/ui/features/account/account-usage-view";
import { useText } from "@openbot/ui/text";
import { Dynamic, type JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";

/** An item of the right-click menu of a rail button. */
interface RailMenuItem {
  label: string;
  icon: typeof Bot;
  open: (button: HTMLElement) => void;
}

/** The right-click menu of a pinned rail button: the actions of its page, then Unpin. */
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

/**
 * One rail button. Its name shows as a tooltip, unless it has a `card`: the card shows instead. With
 * `menu`, a right-click opens a menu of more actions of the page.
 */
function RailButton(props: {
  label: string;
  /** Renders the card while it is open. */
  card?: () => JSX.Element;
  current?: boolean;
  class?: string;
  menu?: readonly RailMenuItem[] | undefined;
  onClick: (button: HTMLElement) => void;
  /** Starts to load the page when the pointer or the focus comes to the button, before the click. */
  onPreload?: (() => void) | undefined;
  children: JSX.Element;
}) {
  // The open menu hides the tooltip, as the More menu does.
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

/** The answer of one custom agent to its usage prompt. OpenBot cannot read a percent from it. */
export interface CustomAgentUsageRailRow {
  id: string;
  name: string;
  text: string;
}

/**
 * Fork #86: when the provider columns of the usage card wrap onto more rows, CSS keeps the card as wide
 * as the room it had, with an empty strip on the right. This box narrows the card to its widest row of
 * columns, again after each size change.
 */
function UsageCardSummary(props: { children: JSX.Element }) {
  let summary: HTMLDivElement | undefined;
  const fit = () => {
    const card = summary?.parentElement;
    if (!summary || !card) return;
    card.style.removeProperty("width");
    // Sub-pixel edges, divided by the open motion's scale; offset* sizes round and can wrap the last column.
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

/**
 * Fork: one usage button for all providers, not one ring per provider (Elias, 6 Nov 2026: the stack
 * of rings was distracting). The button is a plain gauge icon with no rings. The hover card has one
 * column per provider (Claude, ChatGPT…), side by side; each column stacks the accounts of that
 * provider with their limits and reset times. The answers of the custom agents follow as more columns.
 */
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

const RING = { size: 34, stroke: 2.25 };

/** The credits of a media service that a canvas step spends, such as Sunra or Higgsfield. */
export interface MediaCreditsRailRow {
  provider: "sunra" | "higgsfield";
  name: string;
  /** The credits that the account can spend now. */
  available: number;
  /** The limit of a team member, or null for an account with no limit of its own. */
  quota: number | null;
}

/**
 * The credits of one media service. A team quota draws a ring with the part that is left, as the
 * plan limits of a provider do. An account with no limit of its own shows the logo with the number of
 * credits under it. The hover card shows the full number.
 */
function MediaCreditsButton(props: { row: MediaCreditsRailRow; onOpen: (button: HTMLElement) => void }) {
  const { t, format } = useText();
  /** The part of the quota that is left, 0 to 100. A quota of 0 has nothing left. */
  const percent = () => {
    const quota = props.row.quota ?? 0;
    return quota > 0 ? Math.min(100, Math.round((props.row.available / quota) * 100)) : 0;
  };
  const label = () => {
    const credits = format.number(props.row.available);
    const quota = props.row.quota;
    return quota !== null
      ? t("app.rail.mediaCreditsQuota", { name: props.row.name, credits, quota: format.number(quota) })
      : t("app.rail.mediaCredits", { name: props.row.name, credits });
  };
  const radius = (RING.size - RING.stroke) / 2;
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
      class="window-rail-usage"
      onClick={props.onOpen}
    >
      <Show
        when={props.row.quota !== null}
        fallback={
          <span class="window-rail-credits" aria-hidden="true">
            <ProviderLogo provider={props.row.provider} class="window-rail-usage-logo" />
            <span class="window-rail-credits-count">{format.compact(props.row.available)}</span>
          </span>
        }
      >
        <svg class="window-rail-usage-ring" viewBox={`0 0 ${RING.size} ${RING.size}`} fill="none" aria-hidden="true">
          <circle
            class="window-rail-usage-track"
            cx={RING.size / 2}
            cy={RING.size / 2}
            r={radius}
            stroke-width={RING.stroke}
          />
          <Show when={percent() > 0}>
            <circle
              class="window-rail-usage-arc"
              data-usage-tone={usageTone(percent())}
              cx={RING.size / 2}
              cy={RING.size / 2}
              r={radius}
              stroke-width={RING.stroke}
              stroke-linecap="round"
              pathLength={100}
              stroke-dasharray={`${percent()} 100`}
            />
          </Show>
        </svg>
        <ProviderLogo provider={props.row.provider} class="window-rail-usage-logo" />
      </Show>
    </RailButton>
  );
}

/** The rail pages. Agents and Routines show the same page with a different sidebar list. */
export type PageRailPage =
  | "agents"
  | "routines"
  | "workflows"
  | "tasks"
  | "schedule"
  | "usage"
  | "library"
  | "providers"
  | "crm"
  | "marketplace"
  | "settings";

/** The pages that the user can pin to the rail, in rail order. Agents always shows. */
export const PAGE_RAIL_PINNABLE_PAGES = [
  "routines",
  "workflows",
  "tasks",
  "schedule",
  "usage",
  "library",
  "providers",
  "crm",
] as const satisfies readonly PageRailPage[];
export type PageRailPinnablePage = (typeof PAGE_RAIL_PINNABLE_PAGES)[number];

export interface PageRailProps {
  hidden: boolean;
  /** The page in the card, or `null` while a page that the rail does not open shows. */
  current: PageRailPage | null;
  /** The pages that show as rail buttons. The More menu has all pages, with a pin for each one. */
  pinned: readonly PageRailPinnablePage[];
  onPinChange: (page: PageRailPinnablePage, pinned: boolean) => void;
  /** The plan limits of each provider account. Each one with a reported window shows as rings. */
  usageRows: readonly AccountUsageProviderRow[];
  /** The answers of the custom agents on this computer that have a usage prompt. Absent on the web. */
  customAgentUsage?: readonly CustomAgentUsageRailRow[] | undefined;
  /** The credits of the media services that the open Canvas page can spend. Absent on other pages. */
  mediaCredits?: readonly MediaCreditsRailRow[] | undefined;
  /** Opens the app page of a media service. */
  onMediaCredits?: ((provider: MediaCreditsRailRow["provider"]) => void) | undefined;
  onAgents: () => void;
  /** Absent when the server has no routines. */
  onRoutines?: (() => void) | undefined;
  /** Absent when the server has no workflows. */
  onWorkflows?: (() => void) | undefined;
  /** Starts to load the code of the Workflows page before a click opens it. */
  onPreloadWorkflows?: (() => void) | undefined;
  /** Absent where the server keeps no tasks. */
  onTasks?: ((button: HTMLElement) => void) | undefined;
  /** Absent where there is no schedule page. */
  onSchedule?: ((button: HTMLElement) => void) | undefined;
  onUsage: (button: HTMLElement) => void;
  /** Absent where the server keeps no files, such as the web client. */
  onLibrary?: ((button: HTMLElement) => void) | undefined;
  /** Opens the Providers settings of the server. Absent when this account cannot manage them. */
  onProviders?: ((button: HTMLElement) => void) | undefined;
  /** Absent for a member, and on a joined server without the CRM. */
  onCrm?: ((button: HTMLElement) => void) | undefined;
  /** Opens the CRM with its connectors, from the right-click menu of the CRM button. */
  onCrmConnectors?: ((button: HTMLElement) => void) | undefined;
  /** Absent while Marketplace cannot open. */
  onMarketplace?: (() => void) | undefined;
  onSettings: (button: HTMLElement) => void;
  /** A notice for the Settings button, such as an update, when no other place shows it. A dot marks it. */
  settingsNotice?: string | undefined;
  /** The Help menu, between Marketplace and Settings. */
  help: JSX.Element;
  /** The menu of the open server, below Settings. Absent where the window has one server and no menu. */
  server?: JSX.Element;
  /**
   * The OpenBot logo in the top row, for a window that has no macOS window buttons there. With
   * `href`, the logo is a link to the OpenBot site.
   */
  logo?: { variant: AppLogoVariant; href?: string | undefined } | undefined;
}

/** A page that the user can pin to the rail. */
interface RailPage {
  id: PageRailPinnablePage;
  label: string;
  icon: typeof Bot;
  open: (button: HTMLElement) => void;
  /** Starts to load the page before a click opens it. */
  preload?: (() => void) | undefined;
  /** The right-click menu of its rail button. */
  menu?: readonly RailMenuItem[] | undefined;
}

/**
 * The More button of the rail. Its menu lists every page that the user can pin. A row opens its page;
 * the pin at the end of the row pins or unpins it, and the menu stays open. When the open page has no
 * rail button, the More button shows as the current page.
 */
function RailMoreMenu(props: {
  pages: readonly RailPage[];
  current: PageRailPage | null;
  pinned: readonly PageRailPinnablePage[];
  onPinChange: (page: PageRailPinnablePage, pinned: boolean) => void;
}) {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLElement | undefined;
  // A pin adds or removes a rail button above More, so the trigger moves. The menu keeps the place
  // where it opened, so the row under the pointer stays the same.
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
              // The pin is its own menu item beside the page, so the keyboard reaches it.
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

/** The logo in the top row of the rail, in line with the icons of the rail and the server logo of the sidebar. */
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

/**
 * The page rail at the left of the window, on desktop and on the web. Its buttons change the page in
 * the card. One usage button shows the plan limits of every provider and opens the usage page.
 */
export function PageRail(props: PageRailProps) {
  const { t } = useText();
  /** The readings with limits. A reading that counts another's quota (Cursor on Grok) is listed too. */
  const usageRows = createMemo(() => props.usageRows.filter((row) => row.reportsUsage && row.windows.length > 0));
  /** The pages that this server has, in rail order. */
  const pages = createMemo((): RailPage[] => {
    const list: RailPage[] = [];
    const { onRoutines, onWorkflows, onTasks, onSchedule } = props;
    if (onRoutines) {
      list.push({
        id: "routines",
        label: t("sidebar.view.routines"),
        icon: Workflow,
        open: () => onRoutines(),
      });
    }
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
          <For each={props.mediaCredits ?? []} keyed={(row) => row.provider}>
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
        {/* The slot shows no line while it is empty. */}
        <div class="window-rail-server-slot">{props.server}</div>
      </div>
    </nav>
  );
}
