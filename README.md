# Coderix

<div align="center">

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-orange)](https://pnpm.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![中文](https://img.shields.io/badge/🌐-中文_README-ff69b4?style=flat-square)](README.zh-CN.md)

**An open-source AI coding agent for the terminal and desktop — a project for research and learning.**

</div>

<div align="center">
<img src="./assets/screen.gif" width="80%" alt="Coderix Demo" />
</div>

Coderix is an AI coding agent that runs in your terminal or as a desktop app. It can read, write, and edit files, execute shell commands, search code, and more — all through natural-language conversation. One core engine powers several front ends: an Ink/React terminal UI (TUI), an Electron desktop app (React DOM + Monaco + xterm), a VS Code extension, and TypeScript / Python SDKs.

---

## Purpose & Scope

Coderix is an **independent, open-source project for research and learning** — a study of how LLM coding agents are built: agent loops, tool execution, context management, permissions, and multi-agent orchestration.

- It is **not affiliated with, endorsed by, or sponsored by Anthropic**. "Claude Code" is referenced for comparison only; Coderix is not a product of Anthropic.
- It is meant for **research, education, and personal experimentation**.
- Supported providers: Anthropic, DeepSeek, and any OpenAI-compatible endpoint — bring your own key.

---

## Repository Layout

Coderix is a [pnpm](https://pnpm.io) monorepo:

| Package | What it is |
|---|---|
| `packages/coderix-core` | Framework-agnostic agent engine — query loop, tools, context, providers |
| `packages/coderix-cli` | CLI entry point + Ink/React TUI |
| `packages/coderix-tui` | Reusable terminal-UI primitives |
| `packages/coderix-desktop` | Electron desktop app (React DOM + Monaco + xterm) |
| `packages/coderix-vscode` | VS Code extension |
| `packages/coderix-sdk` | TypeScript SDK |
| `packages/coderix-sdk-python` | Python SDK |

---

## Quick Start

### Prerequisites

- **Node.js >= 22**
- **[pnpm](https://pnpm.io/installation)** — the repository is a pnpm workspace
- An API key from [Anthropic](https://console.anthropic.com), [DeepSeek](https://platform.deepseek.com), or [OpenAI](https://platform.openai.com)

### Install

```bash
git clone https://github.com/AgenticMatrix/coderix.git
cd coderix

./install.sh --local      # CLI only
./install.sh --desktop    # Desktop app only
./install.sh --all        # Both
```

### Development

Coderix ships several interfaces backed by the same core engine:

| Command | Interface |
|---|---|
| `pnpm run dev:cli` | **TUI** — the terminal interface (Ink/React) |
| `pnpm run dev:desk` | **Desktop** — the Electron app (React DOM) |
| `pnpm run dev:vscode` | **VS Code** — the extension |

```bash
# TUI (terminal) version
pnpm run dev:cli

# Desktop (Electron) version
pnpm run dev:desk

# Desktop — one-click launcher, auto-frees port 5173
./start_desk.sh

# VS Code extension
pnpm run dev:vscode
```

Other useful scripts: `pnpm run build` (core + cli), `pnpm run build:all` (+ vscode), `pnpm run typecheck`, `pnpm test`.

### Configure

```bash
# First-time setup wizard
coderix setup

# Or manually edit ~/.coderix/settings.json
```

### Start Coding

```bash
# Interactive session
coderix

# One-shot query
coderix --print "Explain the agent loop in coderix-core"

# Switch model
coderix --model
coderix -m "deepseek/deepseek-v4-pro"
```

---

## Features

- **Beautiful TUI** — Built with [Ink](https://github.com/vadimdemedes/ink) + React 19, full terminal rendering
- **Multi-Provider** — Anthropic (Claude), DeepSeek, OpenAI-compatible endpoints
- **15+ Tools** — read, write, edit, bash, grep, glob, web-fetch, web-search, task management, todo
- **Streaming Tool Queue** — Tools enqueue and execute as they are parsed from the LLM stream, with bounded concurrency (default 32)
- **Streaming** — Real-time text, thinking, and tool-use streaming via ContentBlock events
- **Agent Loop** — Autonomous multi-turn reasoning with tool call execution
- **Permission System** — plan / ask / auto modes with risk-level classification
- **Context Management** — Token budget tracking and automatic compaction
- **Hook System** — Extensible lifecycle hooks
- **Skills** — Pluggable skill modules
- **Session Management** — Checkpoint, resume (`--resume` / `--continue`), fork sessions
- **Model Picker** — Interactive terminal model selection (`coderix --model` / `coderix setup`)
- **Desktop App** — Electron desktop client with Monaco editor, xterm terminal, and source control
- **VS Code Extension** — Coderix inside your editor
- **SDKs** — TypeScript and Python SDKs for programmatic access

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send message |
| `Escape` | Clear input / close sub-agent view |
| `Ctrl+C` | Interrupt agent / kill sub-agents / clear input / double-press to exit |
| `Ctrl+B` | Move sub-agent to background (unblocks main agent, agent keeps running) |
| `Ctrl+T` | Toggle sub-agent transcript view |
| `Ctrl+P` | Toggle task & todo panels |
| `Ctrl+O` | Toggle expand/collapse all blocks |
| `Ctrl+K` | Toggle team picker |
| `Ctrl+Enter` | Insert newline |
| `↑ / ↓` | Navigate input history |
| `← / →` | Move cursor |
| `Tab` | Auto-complete slash command |
| `PageUp / PageDown` | Freeze / unfreeze display |

---

## Configuration

Edit `~/.coderix/settings.json`:

```json
{
  "model_list": [
    {
      "model": [
        {
          "name": "deepseek-v4-pro",
          "price": {
            "input": 3,
            "cache_read_input": 0.025,
            "output": 6,
            "currency": "CNY",
            "unit": 1000000,
            "concurrency": 500,
            "max_context": 1000000
          }
        },
        {
          "name": "deepseek-v4-flash",
          "price": {
            "input": 1,
            "cache_read_input": 0.02,
            "output": 2,
            "currency": "CNY",
            "unit": 1000000,
            "concurrency": 2500,
            "max_context": 1000000
          }
        }
      ],
      "provider": "deepseek",
      "base_url": "https://api.deepseek.com/anthropic",
      "auth_token_env": "YOUR_DEEPSEEK_API_KEY"
    },
    {
      "model": [
        "claude-sonnet-2025",
        "opus-4.8"
      ],
      "provider": "anthropic",
      "base_url": "https://api.anthropic.com",
      "auth_token_env": "YOUR_ANTHROPIC_API_KEY",
      "price": {
        "input": 3,
        "output": 15,
        "currency": "USD",
        "unit": "1M tokens"
      }
    },
    {
      "model": [
        "gpt-5",
        "gpt-5-mini"
      ],
      "provider": "openai",
      "base_url": "https://api.openai.com/v1",
      "auth_token_env": "YOUR_OPENAI_API_KEY"
    }
  ],
  "default_model": "deepseek/deepseek-v4-pro",
  "max_tool_concurrency": 32,
  "theme": "dark"
}
```

---

## CLI Reference

| Command | Description |
|---|---|
| `coderix` | Start an interactive session |
| `coderix "query"` | One-shot question |
| `coderix --help, -h` | Show help |
| `coderix --version, -V` | Print version |
| `coderix --model, -m [name]` | Interactive model picker, or set the model directly |
| `coderix --setup` / `coderix setup` | First-time setup wizard |
| `coderix --print, -p <query>` | One-shot query |
| `coderix --resume, -r [id]` | Resume a session by ID, or open the session picker |
| `coderix --continue, -c` | Resume the most recent conversation |
| `coderix --gateway, -g` | JSON-RPC gateway mode (stdin/stdout) |
| `coderix --desktop, -d` | WebSocket gateway mode (for the desktop app) |
| `coderix --desktop-port <port>` | WebSocket port for desktop mode (default 9754) |
| `coderix --sdk` | SDK stream-json mode (stdin/stdout, for SDK clients) |
| `coderix --chrome-mcp` | Start the Chrome MCP server (stdin/stdout) |
| `coderix --chrome-mcp-port <n>` | CDP port for Chrome (default 9222) |
| `coderix --computer-use-mcp` | Start the Computer Use MCP server (macOS) |
| `coderix mcp` | Manage MCP servers |

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
