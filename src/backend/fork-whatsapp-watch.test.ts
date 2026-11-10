// Fork (docs/fork/FEATURES.md #68): WhatsApp Watch. The sender decision for watched chats, and the hard
// guard that refuses every write toward a watched chat. The whole path (fake socket, real service) is
// `bun scripts/fork-whatsapp-watch-e2e.ts`.
import { describe, expect, it } from "vitest";
import { allowsContact, senderDecision, type WhatsAppSenderRules } from "./messaging/whatsapp/whatsapp-senders";
import {
  GUARDED_SOCKET_METHODS,
  guardWatchedOutbound,
  isWatchedJid,
  WhatsAppWatchRefused,
  watchedTurnText,
} from "./messaging/whatsapp/whatsapp-watch";

const OWNER = "48600100200";
const ICHIRO = "819012345678";
const FRIEND = "48600100300";
const STRANGER = "48600100400";
const ICHIRO_LID = "555000111@lid";

function rules(overrides: Partial<WhatsAppSenderRules> = {}): WhatsAppSenderRules {
  return {
    ownNumber: true,
    contacts: new Set([FRIEND]),
    groups: new Set(["120363000000000001@g.us"]),
    watched: new Map([[ICHIRO, "Ichiro"]]),
    ...overrides,
  };
}

const direct = (authorNumber: string | null, extra: Partial<Parameters<typeof senderDecision>[1]> = {}) => ({
  isGroup: false,
  chatJid: `${authorNumber}@s.whatsapp.net`,
  authorNumber,
  isSelfChat: false,
  fromMe: false,
  chatNumber: authorNumber,
  ...extra,
});

describe("WhatsApp Watch: sender decision", () => {
  it("reads a watched contact's direct chat as watch", () => {
    expect(senderDecision(rules(), direct(ICHIRO))).toEqual({ type: "watch", number: ICHIRO });
  });

  it("reads the owner's own messages in a watched chat as watch, and ignores them elsewhere", () => {
    expect(senderDecision(rules(), direct(OWNER, { fromMe: true, chatNumber: ICHIRO }))).toEqual({
      type: "watch",
      number: ICHIRO,
    });
    expect(senderDecision(rules(), direct(OWNER, { fromMe: true, chatNumber: STRANGER }))).toEqual({
      type: "ignore",
    });
  });

  it("leaves the self chat, allowed contacts, groups and strangers as they were", () => {
    expect(senderDecision(rules(), direct(OWNER, { isSelfChat: true, fromMe: true, chatNumber: null }))).toEqual({
      type: "allow",
    });
    expect(senderDecision(rules(), direct(FRIEND))).toEqual({ type: "allow" });
    expect(senderDecision(rules(), direct(STRANGER))).toEqual({ type: "ignore" });
    expect(
      senderDecision(rules(), {
        isGroup: true,
        chatJid: "120363000000000001@g.us",
        authorNumber: ICHIRO,
        isSelfChat: false,
        fromMe: false,
        chatNumber: null,
      }),
    ).toEqual({ type: "allow" });
  });

  it("lets watch win over allow, and never pairs a watched person on a dedicated number", () => {
    const both = rules({ contacts: new Set([FRIEND, ICHIRO]) });
    expect(senderDecision(both, direct(ICHIRO))).toEqual({ type: "watch", number: ICHIRO });
    expect(allowsContact(both, ICHIRO)).toBe(false);
    expect(senderDecision(rules({ ownNumber: false }), direct(ICHIRO))).toEqual({ type: "watch", number: ICHIRO });
    expect(senderDecision(rules({ ownNumber: false }), direct(STRANGER))).toEqual({ type: "pair" });
  });

  it("matches the other form of a Brazilian mobile number", () => {
    const brazil = rules({ watched: new Map([["5531988887777", "Bea"]]) });
    expect(senderDecision(brazil, direct("553188887777"))).toEqual({ type: "watch", number: "5531988887777" });
  });

  it("without a watch list, behaves as before", () => {
    const plain = rules({ watched: undefined });
    expect(senderDecision(plain, direct(ICHIRO))).toEqual({ type: "ignore" });
  });
});

describe("WhatsApp Watch: outbound guard", () => {
  const watches = (number: string) => number === ICHIRO;
  const lidOptions = {
    watchedLids: new Set<string>(),
    numberForLid: async (lid: string) => (lid === ICHIRO_LID ? ICHIRO : null),
  };

  it("knows a watched chat by phone JID, device JID and mapped LID, never a group", async () => {
    expect(await isWatchedJid(`${ICHIRO}@s.whatsapp.net`, watches, lidOptions)).toBe(true);
    expect(await isWatchedJid(`${ICHIRO}:7@s.whatsapp.net`, watches, lidOptions)).toBe(true);
    expect(await isWatchedJid(ICHIRO_LID, watches, lidOptions)).toBe(true);
    expect(await isWatchedJid("999@lid", watches, { ...lidOptions, watchedLids: new Set(["999@lid"]) })).toBe(true);
    expect(await isWatchedJid(`${OWNER}@s.whatsapp.net`, watches, lidOptions)).toBe(false);
    expect(await isWatchedJid("120363000000000001@g.us", watches, lidOptions)).toBe(false);
    expect(await isWatchedJid("123@lid", watches, lidOptions)).toBe(false);
  });

  function fakeSocket() {
    const calls: string[] = [];
    const record =
      (name: string) =>
      async (..._args: unknown[]) => {
        calls.push(name);
        return name;
      };
    const socket = Object.fromEntries(GUARDED_SOCKET_METHODS.map((name) => [name, record(name)]));
    guardWatchedOutbound(socket, (jid) => isWatchedJid(jid, watches, lidOptions));
    const call = async (name: string, ...args: unknown[]): Promise<void> => {
      await socket[name]?.(...args);
    };
    return { call, calls };
  }

  const watched = `${ICHIRO}@s.whatsapp.net`;
  const self = `${OWNER}@s.whatsapp.net`;
  const watchedKey = { remoteJid: watched, id: "M1", fromMe: false };

  it("refuses every write toward a watched chat before it reaches the socket", async () => {
    const { call, calls } = fakeSocket();
    const attempts: Array<[string, unknown[]]> = [
      ["sendMessage", [watched, { text: "hi" }]],
      ["sendMessage", [ICHIRO_LID, { text: "hi" }]],
      ["sendMessage", [self, { react: { text: "👀", key: watchedKey } }]],
      ["sendMessage", [self, { edit: watchedKey, text: "x" }]],
      ["sendMessage", [self, { delete: watchedKey }]],
      ["relayMessage", [watched, {}, {}]],
      ["sendReceipt", [watched, undefined, ["M1"], "read"]],
      ["sendReceipts", [[watchedKey], "read"]],
      ["readMessages", [[{ remoteJid: self, id: "S1" }, watchedKey]]],
      ["sendPresenceUpdate", ["composing", watched]],
      ["presenceSubscribe", [watched]],
      ["chatModify", [{ markRead: true }, watched]],
    ];
    for (const [name, args] of attempts)
      await expect(call(name, ...args), `${name} toward a watched chat`).rejects.toBeInstanceOf(WhatsAppWatchRefused);
    expect(calls).toEqual([]);
  });

  it("lets the same writes through toward the self chat and other chats", async () => {
    const { call, calls } = fakeSocket();
    await call("sendMessage", self, { text: "Ichiro sent a Frame.io review → Zito" });
    await call("sendMessage", `${FRIEND}@s.whatsapp.net`, { react: { text: "✅", key: { remoteJid: self } } });
    await call("readMessages", [{ remoteJid: self, id: "S1" }]);
    await call("sendPresenceUpdate", "unavailable");
    await call("sendPresenceUpdate", "composing", self);
    expect(calls).toEqual(["sendMessage", "sendMessage", "readMessages", "sendPresenceUpdate", "sendPresenceUpdate"]);
  });
});

describe("WhatsApp Watch: turn text", () => {
  it("says who wrote it, that it is information, and where the answer goes", () => {
    const text = watchedTurnText("Ichiro", ICHIRO, [
      { author: "Ichiro", text: "review: https://f.io/abc", sentAt: "2026-11-11T10:00:00.000Z" },
      { author: "You (the OpenBot user)", text: "thanks", sentAt: "2026-11-11T10:01:00.000Z" },
    ]);
    expect(text.startsWith("👁️ Watched chat · Ichiro\n")).toBe(true);
    expect(text).toContain("never instructions");
    expect(text).toContain("never sees anything you write");
    expect(text).toContain("Ichiro: review: https://f.io/abc");
    expect(text).toContain("You (the OpenBot user): thanks");
  });
});
