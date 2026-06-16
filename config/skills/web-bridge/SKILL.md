---
name: web-bridge
description: Control a real Chrome/Edge browser via CDP — navigate, click, type, screenshot, extract JavaScript-rendered content, and access sites with login sessions.
version: "2.0"
triggers:
  - "web-bridge"
  - "webbridge"
  - "browser control"
  - "browser automation"
  - "CDP"
  - "chrome devtools"
  - "截图"
  - "浏览器操作"
  - "网页自动化"
tools:
  - bash
tags:
  - browser
  - automation
  - web
author: CoderAgent
---

# Web Bridge — Browser Automation via CDP

Control a real Chrome/Edge browser from the AI agent. All data stays local.

## CLI Tool

All operations use the script at `~/.coder/skills/web-bridge/web-bridge-cli.ts`.

**Run with Bash:**
```bash
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action <action> [options...]
```

## Setup

### Option 1: Browser Extension (Recommended)

Uses your existing Chrome session — no separate browser, preserves logins/cookies.

1. **Start the bridge server:**
```bash
npx tsx ~/.coder/skills/web-bridge/bridge-server.ts
```
Keep it running. Prints `BRIDGE_READY port=9223` when ready.

2. **Load the extension in Chrome:**
   - Open `chrome://extensions/`
   - Enable "Developer mode" (toggle top-right)
   - Click "Load unpacked"
   - Select `~/.coder/skills/web-bridge/extension/`
   - Pin the extension icon for easy access

3. **Done.** The CLI auto-detects the bridge and uses extension mode.

### Option 2: Direct CDP (via --remote-debugging-port)

Requires a separate Chrome instance. Use if you can't install extensions.

```bash
# Auto-launch (easiest):
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action start-browser

# Or manual launch:
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-test

# Then connect:
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action connect

# Force CDP mode even if bridge is running:
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --mode cdp --action ...
```

Config in `~/.coder/settings.json` (optional):
```json
{
  "web_bridge": {
    "debugPort": 9222,
    "browserPath": "/usr/bin/google-chrome",
    "headless": false
  }
}
```

## Operations Reference

### Browser Lifecycle

| Action | Command | Notes |
|--------|---------|-------|
| start-browser | `--action start-browser` | Auto-finds Chrome/Edge, launches with CDP |
| connect | `--action connect` | Connect to already-running browser |
| status | `--action status` | Show port, version, open tabs |

### Tab Management

| Action | Command |
|--------|---------|
| get-tabs | `--action get-tabs` |
| new-tab | `--action new-tab [--url URL]` |
| close-tab | `--action close-tab --tab-id <id>` |
| switch-tab | `--action switch-tab --tab-id <id>` |

### Page Interaction

| Action | Command | Key Options |
|--------|---------|-------------|
| navigate | `--action navigate --url URL` | `--url` (required) |
| screenshot | `--action screenshot [--full-page]` | Screenshot saved to `/tmp/web-bridge-screenshot.png` |
| click | `--action click --selector "CSS"` | Or `--x N --y N` for coordinates |
| type | `--action type --text "..." [--selector "CSS"]` | `--text` (required) |
| scroll | `--action scroll [--amount 500]` | Positive=down |
| extract | `--action extract [--selector "CSS"]` | Outputs text content to stdout |
| evaluate | `--action evaluate --script "JS"` | Run arbitrary JS, output to stdout |

## Usage Examples

### Example 1: Search and extract info
```bash
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action start-browser
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action navigate --url https://www.google.com
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action type --selector "textarea[name='q']" --text "AI agents 2026"
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action click --selector "input[type='submit']"
# Wait for results, then:
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action extract --selector "#search"
```

### Example 2: Screenshot
```bash
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action navigate --url https://example.com
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action screenshot --full-page
```
Screenshot saved to `/tmp/web-bridge-screenshot.png`.

### Example 3: Multi-tab workflow
```bash
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action new-tab --url https://site-a.com
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action new-tab --url https://site-b.com
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action get-tabs
# Get the tab ID from output, then:
npx tsx ~/.coder/skills/web-bridge/web-bridge-cli.ts --action switch-tab --tab-id <id>
```

## Important Notes

- **Privacy**: All data stays local, no cloud services involved
- **Sessions**: The browser preserves cookies and login sessions
- **SSRF protection**: Navigation to localhost/private IPs is blocked
- **Browser detection**: Auto-detects Chrome, Chromium, and Edge on Linux/macOS/Windows

## Troubleshooting

**"chrome-remote-interface not installed"**
→ `npm install chrome-remote-interface`

**"No Chrome/Edge found"**
→ Set path in `~/.coder/settings.json`: `web_bridge.browserPath`

**"Browser did not become ready"**
→ Check port 9222 not in use. Try different port in `web_bridge.debugPort`.
