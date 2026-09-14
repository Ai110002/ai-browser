---
name: ai-browser
description: Use the local persistent AI Browser bridge for CDP browser work with isolated agent Spaces, compact Accessibility snapshots, durable login sessions, and human approval for high-risk actions.
whenToUse: When a task needs a visible or background browser, persistent login, web UI interaction, screenshots, downloads, uploads, or browser takeover.
user-invocable: true
disable-model-invocation: false
---

# AI Browser operating rules

## Operator directive — effective now

All supported AI Agents must use this local AI Browser whenever they need to
view or interact with a web page. Do not open the user's daily Chrome, attach
to its tabs, use another browser profile, or simulate the desktop mouse and
keyboard. Use the assigned Space and the local Bridge/MCP tools described
below. The current operator notice is recorded at:
`~/.local/share/ai-browser/AGENT_NOTICE.md`

Use the local `ai-browser` bridge, never desktop mouse/keyboard simulation and never the user's daily Chrome. The bridge controls only the separate Chrome profile under `~/.local/share/ai-browser/profile/`.

## One shared browser, Space-owned tabs

All supported Agents share one AI Browser process, Browser Context, profile,
and headed browser window. A Space is a logical owner of one or more tabs in
that shared browser, not a separate browser window or daily-Chrome session.
Keep every operation in the caller's assigned Space and never inspect or
operate another Space's tabs. Use `browser_new_tab` or `ai-browser tab` when a
new tab is needed; `open` resumes the Space's active tab.

## Space ownership

Choose exactly one Space before any browser action:

| Agent | Space |
|---|---|
| Codex CLI | `codex` |
| Claude Code | `claude` |
| DeepSeek Harness | `deepseek` (fixed) |
| Hermes Agent | `hermes` |
| Gemini CLI | `gemini` |
| OpenCode | `opencode` |

Do not inspect, open, click, navigate, or close another agent's Space. A task must include its own Space ID. Space locks serialize operations, and the bridge rejects conflicting owners when the caller identifies itself.

CLI examples:

```bash
ai-browser open codex https://example.com
ai-browser tab codex https://example.com/other
ai-browser snapshot codex
ai-browser spaces
ai-browser watch codex
ai-browser takeover codex
ai-browser release codex
```

For MCP, use the trusted local command `AI_BROWSER_AGENT=<your-agent> ai-browser mcp` (the per-agent wrappers under `~/.local/share/ai-browser/integrations/` already set this). The available tools are `browser_*`; DeepSeek Harness must use the fixed `deepseek` wrapper/Space.

## Snapshot and refs

Call `browser_snapshot`/`ai-browser snapshot` before interacting. Use only the returned `ref` values. The snapshot contains a compact Accessibility Tree, roles, accessible names, and interactive elements; it intentionally omits input values and full HTML.

Refs expire after navigation, a DOM mutation, or an interaction. If the bridge returns `STALE_REF`, take a new snapshot and select a new ref. Do not guess selectors or reuse old refs.

## Actions and batches

Prefer one bounded `browser_batch` call for a short sequence. A batch is a declarative JSON list of allowed operations, not arbitrary JavaScript:

```json
{
  "space": "codex",
  "steps": [
    {"method": "navigate", "url": "https://example.com"},
    {"method": "snapshot"},
    {"method": "getTitle"},
    {"method": "screenshot", "filename": "example.png"}
  ],
  "timeoutMs": 30000
}
```

The batch API cannot read files, start processes, execute arbitrary JavaScript, read cookies/storage, or exfiltrate secrets. Keep batches <= 40 steps and use the returned step/error number to recover; never retry indefinitely.

## Login and credentials

Do not ask the model or user to put passwords, cookies, tokens, API keys, or OTPs into prompts, environment variables, JSON, command arguments, screenshots, or logs. Use an opaque `credentialRef` only after the user has configured an explicit host mapping, for example `example-email` on `example.com`.

The Credential Broker reads one named secret from GNOME Keyring Secret Service, verifies the current page host against `~/.config/ai-browser/sites.json`, fills it in memory, and never returns the value. It has no list-all-secrets tool. If the current host is not allowed, stop. A same-user Agent with unrestricted shell access can still inspect the user's files/processes/keyring; this is not true secret isolation. Stronger isolation requires a separate Linux user and a restricted broker service.

If login is required, session expires, or the site requests Passkey, CAPTCHA, 2FA, abnormal-login verification, payment, deletion, publishing, or identity confirmation:

1. Stop the operation and report `waiting-user`.
2. Ask the user to complete the flow in the AI Browser window, or use `ai-browser takeover <space>`.
3. After the user finishes, use `ai-browser release <space>` and take a fresh snapshot.
4. Never invent, print, or retry credentials.

Persistent browser storage is already enabled in the AI Browser Profile, so successful manual login survives bridge/Chrome restarts. Do not copy the daily Chrome Profile. If migration is ever requested, list the exact non-financial sites/data first and obtain explicit confirmation.

## Risk levels

- LOW: read, browse, search, title/text, snapshot, screenshot, public download — automatic.
- MEDIUM: fill, upload, edit draft, non-sensitive settings — complete audit log; use `credentialRef` for secrets.
- HIGH: publish, send, delete, buy, pay, refund, transfer, change password/security, financial or trading actions — stop before the final action. The user must run `ai-browser confirm <space>` for exactly one action, or take over manually.

Banking, exchanges, wallets, payment/card-management, and password-manager admin hosts are blocked by default. Do not weaken `sites.json` from an Agent task.

## Cleanup and evidence

At task end, keep only needed tabs, close task pages or call `ai-browser stop` for a disposable Space, and report the Space status. Use `ai-browser logs <space>` only for sanitized operation metadata. Never put page text containing secrets into logs or final responses. Screenshots are written under `~/.local/share/ai-browser/screenshots/<space>/` with password/OTP inputs masked.

Ordinary Chromium CDP does not reproduce an Ego Lite modified-Chromium snapshot implementation. This bridge provides a practical equivalent at the interface level: CDP/Playwright control plus a bounded Accessibility snapshot and stable-per-snapshot refs.
