# AI Browser — operator notice

Effective immediately, every supported AI Agent must use the local persistent
AI Browser for web viewing and web interaction:

All Agents share one AI Browser process, profile, and headed browser window.
Each Agent uses its assigned Space as the owner of its own tab(s). Never
inspect, click, navigate, or close another Agent's tabs.

- Codex CLI → `codex`
- Claude Code → `claude`
- DeepSeek Harness → `deepseek` (fixed)
- Hermes Agent → `hermes`
- Gemini CLI → `gemini`
- OpenCode → `opencode`

Use the local Bridge, the trusted local MCP wrapper, or the installed
`ai-browser` Skill. Take an Accessibility Snapshot before interacting and use
only fresh element refs from that Snapshot.

Do not use the user's daily Chrome Profile, attach to its tabs, use desktop
mouse/keyboard simulation, copy cookies, or put credentials in prompts,
arguments, logs, or files. Keep each Agent in its own Space. Follow the
existing login, allowlist, risk-confirmation, and human-takeover rules.

This notice changes browser routing only. It does not grant permission to
publish, send, delete, purchase, pay, or perform other HIGH-risk actions.
