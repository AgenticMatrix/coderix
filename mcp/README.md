# Coderix MCP server bundle

A secret-free catalog of MCP servers that Coderix installs to `~/.coderix/mcp/`.

## How it works

- `config.json` — the server list. **Never put API keys here.**
- `install.sh` (repo root) copies this whole directory to `~/.coderix/mcp/` on
  first install. If `~/.coderix/mcp/` already exists it is left untouched, so
  your edits and keys survive reinstalls. To force a refresh, delete the
  directory and reinstall.
- The app loads servers from `~/.coderix/mcp/config.json` (lowest precedence;
  `~/.coderix/mcp.json` and `.coderix/mcp.json` override it by name).
- Secrets are stored separately in `~/.coderix/mcp/secrets.json` (mode `0600`),
  never in `config.json`.

## Included servers

| Server | Transport | Needs a key? |
| --- | --- | --- |
| `filesystem` | stdio (`npx`) | no |
| `memory` | stdio (`npx`) | no |
| `sequential-thinking` | stdio (`npx`) | no |
| `playwright` | stdio (`npx`) | no |
| `context7` | http | no |
| `github` | stdio (`npx`) | **yes** — `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `tavily` | stdio (`npx`) | **yes** — `TAVILY_API_KEY` |

Servers that need a key are listed in `disabledServers` and stay off until you
enable them (`/mcp enable github`).

## Setting a key

A server declares the env vars it needs via `secretEnv`:

```json
"github": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "secretEnv": ["GITHUB_PERSONAL_ACCESS_TOKEN"]
}
```

When you enable such a server, Coderix prompts for each missing variable on the
next start (masked input). The value is written to
`~/.coderix/mcp/secrets.json` and merged into the server's environment at
connect time.

Precedence for a secret value: `secrets.json` → the ambient environment variable
of the same name. So CI can just export `GITHUB_PERSONAL_ACCESS_TOKEN` and skip
the prompt.

## Adding your own server

Add an entry under `mcpServers` in `config.json` (or in `~/.coderix/mcp.json`
for a per-user server that isn't part of the bundle), then reinstall or edit
`~/.coderix/mcp/config.json` directly.

```json
"my-server": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "some-mcp-server"],
  "env": { "NON_SECRET_FLAG": "1" },
  "secretEnv": ["MY_API_KEY"]
}
```

See `examples/mcp/` for a runnable reference server, and the Coderix docs for
the full config schema.
