// Fork (docs/fork/FEATURES.md entry 32): end-to-end check of the browser sign-in import on a running
// dev app (`bun run dev` in this worktree, with OPENBOT_FORK_SKIP_TOUCH_ID=1).
//
//   bun scripts/fork-chrome-import-e2e.ts [--port=9333] [--chat]
//
// It imports two real Chrome profiles, only their google.com cookies, into the dev profile, checks
// that a tab in each is signed in to Google, re-syncs, and with --chat asks a Codex agent to choose a
// profile by name. The report goes to .openbot-build/fork-chrome-import-e2e.json. Cookie values are
// never written to the report.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChromeImportResult, ChromeSyncCounts, ConversationWithReadState } from "@openbot/contracts/ipc";
import { chromium, type Page } from "playwright-core";

const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? 9333);
const chat = process.argv.includes("--chat");
const outDir = join(import.meta.dir, "..", ".openbot-build");
const checks: { name: string; ok: boolean; detail: unknown }[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}\n`);
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    value = await read();
  }
  return value;
}

async function main(): Promise<void> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => new URL(candidate.url()).pathname === "/");
  if (!page) throw new Error("The main window is not open.");

  const list = await page.evaluate(() => window.openbot.agent.listChromeProfiles());
  check("lists browser profiles", list.available && list.profiles.length > 0, {
    count: list.profiles.length,
    browsers: [...new Set(list.profiles.map((profile) => profile.browser))],
  });
  const wanted = ["chrome:Default", "chrome:Profile 12"].filter((dir) => list.profiles.some((p) => p.dir === dir));
  const sites = await page.evaluate((dir) => window.openbot.agent.listChromeSites(dir), wanted[0] ?? "");
  check(
    "lists sites of a profile",
    sites.some((site) => site.site === "google.com"),
    {
      sites: sites.length,
      google: sites.find((site) => site.site === "google.com"),
    },
  );

  const linkedBefore = await page.evaluate(() => window.openbot.agent.listChromeLinks());
  const imported: ChromeImportResult = await page.evaluate(
    (dirs) =>
      window.openbot.agent.importChromeProfiles({ profiles: dirs.map((dir) => ({ dir, sites: ["google.com"] })) }),
    wanted,
  );
  const total = (counts: ChromeSyncCounts) => counts.added + counts.updated + counts.kept + counts.unchanged;
  check(
    "imports google.com cookies",
    imported.profiles.length === wanted.length && imported.profiles.every((p) => total(p.counts) > 0),
    imported.profiles.map((p) => ({ name: p.name, counts: p.counts })),
  );
  // A browser profile imported before is synced again into the same profile: no "(2)" copy.
  check(
    "a re-import reuses the linked profile",
    wanted.every((dir, index) => {
      const before = linkedBefore.filter((link) => link.chromeDir === dir).map((link) => link.profileId);
      const now = imported.profiles[index]?.profileId ?? "";
      return before.length === 0 || before.includes(now);
    }),
    { reused: imported.profiles.filter((p) => linkedBefore.some((link) => link.profileId === p.profileId)).length },
  );
  const links = await page.evaluate(() => window.openbot.agent.listChromeLinks());
  check(
    "links each new profile",
    imported.profiles.every((p) => links.some((link) => link.profileId === p.profileId)),
    links.map((link) => ({ browser: link.browser, sites: link.sites })),
  );

  // A tab of an agent whose profile is the imported one: Google keeps it on My Account when signed in.
  const agents = await page.evaluate(() => window.openbot.agent.listAgents());
  const agent = agents[0];
  if (!agent) throw new Error("The dev profile has no agent.");
  const first = imported.profiles[0];
  if (!first) throw new Error("Nothing was imported.");
  await page.evaluate(
    ({ agentId, profileId }) =>
      window.openbot.agent.updateAgentBrowserProfile({ agentId, profile: { kind: "profile", profileId } }),
    { agentId: agent.id, profileId: first.profileId },
  );
  const tab = await page.evaluate(
    (agentId) => window.openbot.browser.open({ url: "https://myaccount.google.com/", ownerAgentId: agentId }),
    agent.id,
  );
  const loaded = await waitFor(
    () =>
      page.evaluate(() => window.openbot.browser.listTabs()).then((tabs) => tabs.find((entry) => entry.id === tab.id)),
    (entry) => Boolean(entry && !entry.url.startsWith("about:") && entry.title),
    30_000,
  );
  const host = loaded ? new URL(loaded.url).hostname : "";
  check("tab is signed in to Google", host === "myaccount.google.com", { host, title: loaded?.title });

  const site = await page.evaluate((tabId) => window.openbot.agent.getChromeSignInSite(tabId), tab.id);
  check("sign-in card offers Chrome for the tab", site === "google.com", { site });
  const signIn = await page.evaluate((tabId) => window.openbot.agent.signInWithChrome(tabId), tab.id);
  check("Use Chrome's sign-in copies one site and reloads", signIn.site === "google.com", signIn);

  const resync = await page.evaluate(
    (profileId) => window.openbot.agent.resyncChromeProfile(profileId),
    first.profileId,
  );
  check("re-sync keeps unchanged cookies", resync.unchanged > 0 && resync.skipped === 0, resync);

  const second = imported.profiles[1];
  if (second) {
    const choice = { agentId: agent.id, profileIds: [second.profileId] };
    const saved = await page.evaluate((input) => window.openbot.agent.updateAgentBrowserProfileChoices(input), choice);
    const read = await page.evaluate(
      (agentId) => window.openbot.agent.getAgentBrowserProfileChoices(agentId),
      agent.id,
    );
    check("saves the agent's other profiles", read.profileIds.join() === saved.profileIds.join(), read);
  }
  await page.evaluate((tabId) => window.openbot.browser.close(tabId), tab.id).catch(() => undefined);

  if (chat && second) await codexChat(page, imported.profiles);

  await page.screenshot({ path: join(outDir, "fork-chrome-import-e2e.png") });
  const report = { at: new Date().toISOString(), passed: checks.every((entry) => entry.ok), checks };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "fork-chrome-import-e2e.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(report.passed ? "ALL PASSED\n" : "SOME FAILED\n");
  await browser.close();
  if (!report.passed) process.exitCode = 1;
}

/** A Codex agent with two profiles opens Google My Account in the one named in the message. */
async function codexChat(page: Page, profiles: ChromeImportResult["profiles"]): Promise<void> {
  const [main, other] = profiles;
  if (!main || !other) return;
  const created = await page.evaluate(() =>
    window.openbot.agent.createAgent({
      name: "Chrome Import Test",
      description: "Checks browser profiles chosen by name.",
      avatarSeed: "chrome-import-test",
      avatarHue: null,
      initialMessage: "Reply with the single word: ready",
      provider: "codex",
    }),
  );
  await page.evaluate(
    ({ agentId, profileId }) =>
      window.openbot.agent.updateAgentBrowserProfile({ agentId, profile: { kind: "profile", profileId } }),
    { agentId: created.id, profileId: main.profileId },
  );
  await page.evaluate((input) => window.openbot.agent.updateAgentBrowserProfileChoices(input), {
    agentId: created.id,
    profileIds: [other.profileId],
  });
  const read = () => page.evaluate((agentId) => window.openbot.agent.readConversation(agentId), created.id);
  const replies = (conversation: ConversationWithReadState) =>
    conversation.messages.filter((message) => message.author === "assistant" && message.status === "completed");
  const before = replies(await waitFor(read, (c) => replies(c).length >= 1, 180_000)).length;
  await page.evaluate((input) => window.openbot.agent.sendMessage(input), {
    agentId: created.id,
    text: `Use your browser tools. First call status and tell me the browserProfiles it lists. Then open https://myaccount.google.com/ with the profile named "${other.name}", read the page, and tell me which Google account email it shows. Answer in two short lines.`,
  });
  const done = await waitFor(
    read,
    (c) => replies(c).length > before && /@/u.test(replies(c).at(-1)?.text ?? ""),
    300_000,
  );
  const answer = replies(done).at(-1)?.text ?? "";
  check("Codex agent opens the named profile", /@/u.test(answer), { answer: answer.slice(0, 400) });
  await page.screenshot({ path: join(outDir, "fork-chrome-import-chat.png") });
}

await main();
