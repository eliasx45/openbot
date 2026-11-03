# Later: features skipped for now

Features Elias skipped, to pick up when he needs them or mentions a gap they'd close. **Agents: when Elias mentions one of these gaps, point to this file and offer the entry.** When one is built, move it to [FEATURES.md](FEATURES.md) in the same commit.

## Skipped Codync features that need a relay or cloud server

Skipped 2026-11-03. Elias: "skip", for now.

- Bots on other computers message each other peer to peer
- ChatGPT/Claude apps hand tasks to bots (Codync's `mcp.codync.dev`)
- Messages sent while the Mac is off wait up to 24 h, encrypted
- Phone ↔ Mac off the home Wi-Fi

Gap signals: "my phone can't reach it away from home", "can ChatGPT/Claude app tell my bots…", "bots on my other Mac", "messages lost while Mac asleep".

What's needed:

- **Relay:** a middleman on the internet. Phone ↔ relay ↔ Mac when not on the same Wi-Fi; holds messages while the Mac is off; carries traffic between your computers.
- **Cloud server:** accounts, plus a public address (like mcp.codync.dev) that the ChatGPT/Claude apps connect to; it passes their tasks to your Mac.
- **Elias's Cloudflare account can host both.** Codync's are Cloudflare Workers: `~/Developer/codync/cloud` (accounts + relay + mcp.codync.dev, Workers + D1, spec `docs/reference/remote-relay.md`) and `~/Developer/codync/relay` (iPhone push). Needs the paid Workers plan (~$5/mo) for live connections, plus a Clerk account for sign-in. Smaller option: `~/Developer/codync/private-relay`, one program just for his computers, on any server or Tailscale. Note: OpenBot has its own cloud (openbot.run); check what it already covers before building.

## Also skipped

- Fallback chain (Claude → Codex → Gemini in the same turn). Elias: "no need for that, skip".
- Terminal app, iPhone Shortcuts/Action button (whole new clients).
