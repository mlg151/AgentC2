# Project OpOrders

An OpOrder is a versioned, desktop-stored definition of project guidance and MCP servers for one SSH host and one absolute Git worktree root. In **Settings → OpOrders**, select a host and remote repository, enter shared instructions and any provider overrides, then preview the remote files. **Apply and enable sync** writes the reviewed revision and enrolls that project. A stale preview or conflict stops the write. **Pause sync** stops future reconciliation; removing an OpOrder also leaves the remote files in place for deliberate review.

Only enrolled orders reconcile after a successful host inventory connection. AgentC2 owns marked sections in `AGENTS.md`, `CLAUDE.md`, `.agents/rules/agentc2.md`, and `.codex/config.toml`, plus individual server names in `.mcp.json` and `.agents/mcp_config.json`. Unrelated text and MCP entries remain in the project. Remote edits to managed content are conflicts; preview shows the affected path. A private manifest and per-apply backups live under `~/.cache/agentc2/oporders/` on the remote host. Writes use temporary files and atomic replacement; a failed apply rolls back earlier writes and retains the original file modes. Resolve a conflict by editing the remote managed section or the local OpOrder, then preview again. Backups are available for manual recovery after an interrupted host or power failure.

The MCP editor accepts an array of server objects. For example:

```json
[
  {
    "name": "docs",
    "transport": "http",
    "url": "https://mcp.example.com/endpoint",
    "providers": ["codex", "claude"],
    "headers": { "Authorization": "DOCS_AUTH_HEADER" }
  },
  {
    "name": "database",
    "transport": "stdio",
    "command": "db-mcp",
    "args": ["--readonly"],
    "providers": ["codex", "claude"],
    "env": ["DATABASE_TOKEN"]
  }
]
```

`env` contains remote environment variable **names**, and each `headers` value is a remote environment variable name. Put actual credentials in the remote provider environment; OpOrders never store secret values. HTTP URLs must be HTTPS and cannot embed credentials, query strings, or fragments. Antigravity MCP environment and header references currently fail preview because its workspace expansion behavior has not been verified. Codex-only instruction overrides also fail preview; shared `AGENTS.md` is supported, while Codex's `model_instructions_file` would replace rather than append project instructions. Unsupported conversions must be removed or scoped to supported providers before applying.

Provider formats were checked against the [Codex configuration guide](https://learn.chatgpt.com/docs/config-file/config-basic) and [reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp), and [Antigravity MCP](https://antigravity.google/docs/mcp) and [rules](https://antigravity.google/docs/rules-workflows) documentation. Project trust, provider-level MCP approval, and the provider's own runtime environment still govern whether a rendered server is actually available to an agent.
