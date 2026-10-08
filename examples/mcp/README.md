# Demo MCP server

A minimal reference MCP server used to demonstrate Coderix's MCP integration.
It exposes four tools (`echo`, `get_time`, `calc`, `server_info`) and two prompt
templates (`greet`, `summarize`).

There are two equivalent forms:

## 1. Built-in (in-process) — `coderix --demo-mcp`

The same server ships inside `@coderix/core` as
`packages/coderix-core/src/mcp/builtin/demo-mcp/`. It is the template to copy
when adding a new built-in MCP server.

```bash
# Start it as a standalone stdio process (useful for testing / other clients)
coderix --demo-mcp
```

Register it with Coderix by adding to `.coderix/mcp.json` (project) or
`~/.coderix/mcp.json` (user). If `coderix` is on your `PATH`:

```json
{
  "mcpServers": {
    "demo": { "type": "stdio", "command": "coderix", "args": ["--demo-mcp"] }
  }
}
```

## 2. Standalone script — `examples/mcp/demo-server.mjs`

A self-contained script that only imports `@modelcontextprotocol/sdk` (no
Coderix code). Use it to see the "external server" path end to end.

```bash
# Run it directly
node examples/mcp/demo-server.mjs
# or
pnpm mcp:demo
```

Then point Coderix at it. Copy `examples/mcp/mcp.json` into your project as
`.coderix/mcp.json`:

```bash
mkdir -p .coderix
cp examples/mcp/mcp.json .coderix/mcp.json
```

The config runs `node examples/mcp/demo-server.mjs` **relative to the working
directory**, so either run Coderix from the repo root or replace the path with an
absolute one.

## Verify

Inside the Coderix TUI:

- `/mcp` — the `demo` server should show as connected with 4 tools
- `/mcp prompts demo` — lists the `greet` and `summarize` prompt templates
- ask the model to call `echo`/`calc`, or run
  `/mcp prompt demo greet name=Ada`

From a terminal:

```bash
coderix mcp list          # shows status/tools for configured servers
coderix mcp reconnect demo
```
