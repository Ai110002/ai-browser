# AI Browser

Persistent local browser infrastructure for AI Agents. It uses one sandboxed
headed/headless Chrome/Chromium process, one persistent AI Browser Profile,
and logical Agent Spaces that own separate tabs in the shared browser window.

## Architecture

```text
Codex / Claude / dsh / Hermes / Gemini / OpenCode
                    |
          Skill or trusted local MCP
                    |
             Unix-socket Bridge
                    |
       private CDP pipe to Chrome/Chromium
                    |
       shared AI Browser Profile + Space tabs
```

Spaces are tab ownership and locking boundaries, not separate daily-browser
profiles. The daily Chrome profile is never copied or controlled.

## Features

- Persistent cookies, local storage, IndexedDB and service-worker state.
- Compact Accessibility snapshots with per-snapshot element refs.
- Bounded batch operations; no arbitrary filesystem or subprocess API.
- LOW / MEDIUM / HIGH risk policy with human confirmation before final HIGH actions.
- GNOME Keyring/libsecret credential references with host allowlists.
- Masked screenshots and redacted rotating operation logs.
- Crash recovery, systemd user service, per-Space locks and resource limits.
- Trusted local MCP wrappers for six supported Agents.

## Runtime commands

```bash
ai-browser service enable
ai-browser status
ai-browser open codex https://example.com
ai-browser tab codex https://example.com/other
ai-browser snapshot codex
ai-browser spaces
ai-browser takeover codex
ai-browser release codex
```

The service unit is a template in `systemd/ai-browser.service.in`; substitute
the local Node binary and installation path before enabling it.

## Security boundary

Never commit `profile/`, `sessions/`, `state/`, logs, screenshots, downloads,
Keyring contents, cookies, passwords, tokens, or API keys. Agents sharing the
same Linux user and unrestricted Shell access are not a true secret-isolation
boundary; use a separate Linux user and a restricted Broker for stronger
isolation.

HIGH-risk actions (publish, send, delete, purchase, payment, refund, transfer,
password/security changes and financial actions) stop before final submission.
CAPTCHA, Passkey, 2FA and abnormal-login checks require human takeover.

## Install from source

```bash
cd app
npm ci --omit=dev
install -Dm755 cli.mjs ~/.local/bin/ai-browser
```

Copy the skill to the target Agent's skill directory and configure the trusted
local MCP wrapper from `integrations/`. Do not copy an existing daily Chrome
Profile.

## Verification

```bash
node --check app/bridge.mjs
node --check app/cli.mjs
node --check app/mcp.mjs
npm audit --omit=dev
```

This repository contains source and deployment documentation only. Runtime
data is intentionally excluded.
