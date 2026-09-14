# DeepSeek Harness integration

The official dsh filesystem skill provider is already enabled in the installed `web` profile. The compatible local skill is:

`~/.dsh/skills/ai-browser/SKILL.md`

It fixes DeepSeek Harness to the `deepseek` Space and instructs the agent to use the local bridge rather than desktop input or unknown third-party MCP servers.

For an MCP-capable dsh profile, use this trusted local stdio server command:

`~/.local/share/ai-browser/integrations/mcp-deepseek`

It exposes only bounded `browser_*` tools, uses the persistent AI Browser Profile, reports `waiting-user` for login/2FA/CAPTCHA/high-risk actions, and has no credential-listing tool. The existing `~/.dsh/profiles/web` and `~/.dsh/cordis.patch.yml` are not modified by this integration.

The plain CLI fallback is always available:

```bash
AI_BROWSER_AGENT=deepseek ai-browser open deepseek https://example.com
AI_BROWSER_AGENT=deepseek ai-browser snapshot deepseek
```

Restart verification: restart dsh and reload the `ai-browser` skill; it is discovered from `~/.dsh/skills` by `@deepseek-ai/dsh-skill-filesystem` without a profile edit.
