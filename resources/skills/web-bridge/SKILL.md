---
name: web-bridge
description: Control a real browser via CDP — navigate, click, type, screenshot, and extract web content. No Chrome extension required.
version: "2.1"
triggers: [web-bridge, webbridge, browser control, browser automation, CDP, chrome devtools, 截图, 浏览器操作, 网页自动化]
tools: [bash]
tags: [browser, automation, web]
author: Coderix
---

# Web Bridge — Browser Automation via CDP

Control a real Chrome/Edge browser from the AI agent. **No extension installation needed.** All data stays local.

## Quick Start

### Start the bridge server (one command)

```bash
node ~/.coderix/skills/web-bridge/bridge-server.cjs
```

The server auto-detects Chrome/Edge, launches it with remote debugging, and listens on port **9223**. You'll see `BRIDGE_READY port=9223` when ready.

If Chrome is already running with `--remote-debugging-port=9222`, the server connects to it instead of launching a new one.

### Make a request

```bash
curl -s -X POST http://127.0.0.1:9223/cmd \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","params":{"url":"https://example.com"}}'
```

All commands go to `POST /cmd` with JSON body `{"action":"...", "params":{...}}`.

### Sessions

Add `"session":"name"` to the request body to isolate tabs for multi-task workflows. Each session tracks its own set of tabs.

```bash
# Start a task in its own session
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"navigate","params":{"url":"https://example.com","new_tab":true},"session":"research"}'

# Later actions in the same session automatically use the right tab
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"snapshot","session":"research"}'

# Close all tabs in a session when done (session name optional if active)
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"close_session","session":"research"}'

# Or close the last active session without naming it
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"close_session"}'
```

Without a session, all operations use the first available tab.

### Health check

```bash
curl -s http://127.0.0.1:9223/
# {"status":"ok","version":"Chrome/150...","uptime_seconds":120,"extensionConnected":false,"mode":"cdp","port":9223,"cdpPort":9222}
```

### Server options

| Flag | Description |
|------|-------------|
| `--port 9223` | Listen port (default: 9223) |
| `--cdp-port 9222` | CDP debug port (default: 9222) |
| `--browser-path /path/to/chrome` | Custom browser binary |
| `--headless` | Run browser headless |
| `--no-auto-launch` | Don't auto-launch browser (connect to existing) |

## Operations Reference

### Browser Lifecycle

| Action | Params | Notes |
|--------|--------|-------|
| `status` | — | Returns `{connected, debugPort, version, tabCount, uptime_seconds, sessionCount, sessions}` |

### Tab Management

| Action | Params | Returns |
|--------|--------|---------|
| `get_tabs` | — | `[{id, url, title, active, sessions}]` |
| `new_tab` | `url` (optional) | `{created: true, tabId}` |
| `close_tab` | `tab_id` (required) | `{closed: true}` |
| `close_session` | — (session from body, optional if active) | `{closed: N}` — closes all tabs in session |
| `switch_tab` | `tab_id` (required) | `{switched: true}` |
| `find_tab` | `url` or `active` (bool) | `{id, url, title}` — match by hostname, or find the active tab |

### Page Interaction

| Action | Key Params | Notes |
|--------|-----------|-------|
| `navigate` | `url` (required), `new_tab` (bool) | Navigate current tab or open new one |
| `snapshot` | — | Returns accessibility tree with `@e` refs for interactive elements |
| `screenshot` | `format`, `quality`, `full_page`, `selector`, `tab_id`, `path` | Writes to `~/.coderix/screenshots/` (or `path` if given), returns `{path, sizeBytes, mimeType}` |
| `click` | `selector` (CSS or `@e` ref), or `x`+`y` | Supports `@e` refs from snapshot |
| `mouse_click` | `selector` (required) | Real mouse events at element center via `getBoxModel` |
| `fill` | `selector`, `value` | Clear-and-insert. Works on `<input>`, `<textarea>`, `[contenteditable]` |
| `type` | `text`, `selector` (optional) | Simple text insertion without clearing |
| `send_keys` | `keys` (e.g. `"Enter"`, `"Mod+A"`, `"Shift+Tab"`), `repeat` | Full keyboard dispatch with modifier support |
| `scroll` | `amount` (default 500) | Positive=down |
| `extract` | `selector` (optional) | Returns `{content, length}` |
| `evaluate` | `script` (required) | Supports async/await, returns `{type, value}` |

### Advanced

| Action | Key Params | Notes |
|--------|-----------|-------|
| `upload` | `selector`, `files` (string array) | Sets files on `<input type=file>` |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, `path` | Writes to `~/.coderix/pdfs/` (or `path` if given), returns `{path, sizeBytes, mimeType}` |
| `network` | `cmd`: `start`/`stop`/`list`/`detail`, `filter`, `requestId` | HTTP request capture |
| `cdp` | `method` (e.g. `"Page.captureScreenshot"`), `params` | Raw CDP method passthrough |

## Using `@e` refs from snapshot

`snapshot` returns interactive elements with `@e` refs based on semantic role/name. Use them directly with `click` / `fill` / `mouse_click` — they survive CSS class hash changes that break manually-written selectors.

```bash
# Get a snapshot
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"snapshot"}'

# Click a button by ref
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"click","params":{"selector":"@e1"}}'

# Fill a textbox by ref
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"fill","params":{"selector":"@e3","value":"hello"}}'
```

## Screenshots: read the returned path

The server writes the image to disk and returns `{path, format, sizeBytes, mimeType}`. Use the `Read` tool to view it.

```bash
# Default — PNG, full viewport
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"screenshot","params":{}}'

# Full-page
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"screenshot","params":{"full_page":true}}'

# Element-only via @e ref from snapshot
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"screenshot","params":{"selector":"@e5"}}'

# JPEG with quality
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"screenshot","params":{"format":"jpeg","quality":60}}'

# Custom path
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"screenshot","params":{"path":"/Users/me/Desktop/shot.png"}}'
```

### Finding tabs

```bash
# Find by hostname
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"find_tab","params":{"url":"https://example.com"}}'

# Find the currently active tab
curl -s -X POST http://127.0.0.1:9223/cmd \
  -d '{"action":"find_tab","params":{"active":true}}'
```

## CLI (alternative to curl)

A TypeScript CLI is also available for one-shot commands:

```bash
npx tsx ~/.coderix/skills/web-bridge/web-bridge-cli.ts --action navigate --url https://example.com
npx tsx ~/.coderix/skills/web-bridge/web-bridge-cli.ts --action snapshot
npx tsx ~/.coderix/skills/web-bridge/web-bridge-cli.ts --action screenshot --full-page
```

The CLI auto-detects whether the bridge server is running — if so, it delegates to it; otherwise it connects to CDP directly.

## Optional: Browser Extension

For users who want to control their **existing Chrome session** (with logins/cookies preserved) without launching a separate browser instance, an optional extension is available.

1. Start the bridge server (as above)
2. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" → select `~/.coderix/skills/web-bridge/extension/`
3. The server auto-detects the extension and switches to extension mode

When the extension is connected, commands are relayed through `chrome.debugger` API. All CDP features are available in both modes.

## Important Notes

- **Privacy**: All data stays local, no cloud services involved
- **Sessions**: The browser preserves cookies and login sessions
- **SSRF protection**: Navigation to localhost/private IPs is blocked (CLI mode)
- **Browser detection**: Auto-detects Chrome, Chromium, and Edge on Linux/macOS/Windows

## Troubleshooting

**"No Chrome/Edge found"**
→ Set `--browser-path` flag when starting the server, or set `web_bridge.browserPath` in `~/.coderix/settings.json`.

**"chrome-remote-interface not installed"**
→ `cd ~/.coderix/skills/web-bridge && npm install`

**Port 9222 already in use**
→ The server auto-detects and connects. To use a different port: `--port 9224` (the CDP debug port is always the same as the server port).

**Address already in use (9223)**
→ Another instance is already running. Stop it first or use `--port 9224`.
