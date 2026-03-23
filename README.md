# Agent Dashboard Plugin for Claude Code

Real-time web dashboard that visualizes Claude Code subagent status and activity. See which agents are running, what files they're reading, what commands they're executing, and when they finish — all in a live-updating browser UI.

![Dashboard showing agent cards and activity log](https://img.shields.io/badge/status-working-brightgreen)

## How It Works

```
Claude Code hooks (HTTP POST) --> Dashboard Server (port 8099) --> WebSocket/Polling --> Browser
```

The plugin registers hooks for `SubagentStart`, `SubagentStop`, `PreToolUse`, and `PostToolUse` events. When Claude Code spawns subagents or they use tools, hook events are POSTed to the dashboard server, which pushes real-time updates to connected browsers via WebSocket (with HTTP polling fallback).

## Prerequisites

- **Node.js** v18+ (no npm install needed — zero dependencies)
- **Claude Code** CLI installed

## Installation

### Option A: Marketplace (recommended)

```bash
# Add the marketplace
/plugin marketplace add cfirz/claude-agent-dashboard

# Install the plugin (global — hooks activate for all projects)
/plugin install agent-dashboard@cfir-claude-plugins
```

### Option B: Direct Install from GitHub

```bash
# Clone and install locally
git clone https://github.com/cfirz/claude-agent-dashboard.git
claude plugin install --plugin-dir ./claude-agent-dashboard --scope user
```

### Option C: Manual Hook Setup

If you prefer not to use the plugin system, add the hooks directly to your Claude Code settings.

**Global** (`~/.claude/settings.json`) or **project** (`.claude/settings.json`):

```json
{
  "hooks": {
    "SubagentStart": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/subagent-start" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/subagent-stop" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/pre-tool-use" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/post-tool-use" }] }
    ]
  }
}
```

> If you already have hooks in your settings, merge these entries into the existing `hooks` object. Multiple hook entries for the same event are supported.

## Usage

### 1. Start the dashboard server

```bash
node /path/to/agent-dashboard/server/server.mjs
```

The server starts on port 8099 by default. Override with:

```bash
PORT=9000 node /path/to/agent-dashboard/server/server.mjs
```

### 2. Open the dashboard

Navigate to **http://localhost:8099** in your browser.

### 3. Use Claude Code normally

Agent cards appear automatically as subagents are spawned. Each card shows:
- Agent name and current status
- What the agent is doing right now (e.g., "Reading Scripts/Player/PlayerController.cs")
- Number of tools used
- Time since last activity

The activity log at the bottom shows a timestamped feed of all agent events.

## Important: Hook Timing

Hooks must be registered **before starting** your Claude Code session (or before spawning agents). If you add hooks to `settings.json` mid-session, only agents spawned after that point will be tracked. For best results:

1. Install the plugin or add hooks to settings
2. **Then** start a new `claude` session
3. Start the dashboard server
4. Work normally — all agents will be tracked

## Agent Status Types

| Status | Visual | Meaning |
|--------|--------|---------|
| **Working** | Green pulsing dot, green border | Agent is actively running with live activity updates |
| **Stale?** | Amber dot, dimmed card | Agent was working but no events received for 30s+ — may have finished without a stop event |
| **Completed** | Blue dot, blue border | Agent finished normally, auto-resets to idle after 30s |
| **Idle** | Gray dot, default border | No active session for this agent |

## Activity Descriptions

The dashboard converts raw tool calls into human-readable descriptions:

| Tool | Example Display |
|------|----------------|
| `Read` | Reading Scripts/Player/PlayerController.cs |
| `Edit` | Editing Scripts/Core/GameManager.cs |
| `Write` | Writing Scripts/UI/NewPanel.cs |
| `Grep` | Searching: "PlayerController" |
| `Glob` | Finding files: **/*.cs |
| `Bash` (npm test) | Running tests |
| `Bash` (npm run lint) | Running linter |
| `Bash` (git ...) | Git: status |
| MCP Unity tools | Recompiling Unity scripts / Inspecting Player / etc. |
| `WebSearch` | Web search: "unity animation" |
| Any other tool | Using ToolName |

## Architecture

### Server (`server/server.mjs`)
- Zero-dependency Node.js server using built-in `http` and `crypto` modules
- Receives hook events via HTTP POST on `/hooks/*` endpoints
- Maintains in-memory agent state (not persisted — resets on server restart)
- WebSocket push for real-time updates, with HTTP polling fallback (`/api/state`)
- Stale agent detection: 30s no events = amber warning, 90s = auto-idle

### Dashboard (`ui/dashboard.html`)
- Single HTML file with inline CSS and JavaScript
- Dark theme (GitHub dark palette)
- Responsive CSS grid layout for agent cards
- WebSocket connection with automatic reconnect + HTTP polling fallback
- Relative timestamps updated every second

### Hooks (`hooks/hooks.json`)
- Four HTTP hooks that POST event data to `localhost:8099`
- All hooks fail silently when the dashboard server is not running — no impact on Claude Code performance

## Configuration Reference

| Setting | Default | How to Change |
|---------|---------|---------------|
| Server port | 8099 | `PORT` env var |
| Stale warning threshold | 30s | Edit `server.mjs` line with `age > 30_000` |
| Auto-idle timeout | 90s | Edit `server.mjs` line with `age > 90_000` |
| Completed-to-idle delay | 30s | Edit `server.mjs` `setTimeout` in `handleSubagentStop` |
| Activity log buffer size | 100 entries | Edit `MAX_LOG` in `server.mjs` |
| Polling interval | 2s | Edit `setInterval(pollState, 2000)` in `dashboard.html` |

## Known Limitations

- **Agent type grouping**: Multiple agents of the same type (e.g., two Explore agents) share a single card. The card shows the latest instance's status. The activity log tracks all instances individually.
- **In-memory state**: Dashboard state resets when the server restarts. There is no persistence.
- **No authentication**: The dashboard server has no auth. It binds to localhost only, which is fine for local development.
- **WebSocket proxy**: Some environments (e.g., Claude Code's preview tool) don't support WebSocket upgrade. The dashboard falls back to HTTP polling in these cases.

## Troubleshooting

**Dashboard shows "No agents yet" but agents are running**
- Hooks may not be registered. Check with `/hooks` in Claude Code to see active hooks.
- Hooks added mid-session only apply to newly spawned agents. Start a new session.
- Verify the dashboard server is running: `curl http://localhost:8099/api/state`

**Port 8099 is already in use**
- Another instance may be running. Find and kill it:
  ```bash
  # Linux/Mac
  lsof -ti:8099 | xargs kill
  # Windows
  netstat -ano | findstr 8099
  taskkill /PID <pid> /F
  ```
- Or use a different port: `PORT=9000 node server/server.mjs`

**Agent cards stuck on "Working"**
- The stale detection will mark them "Stale?" after 30s and auto-idle after 90s.
- If the `SubagentStop` hook doesn't fire (rare), this is the safety net.

## Files

```
claude-agent-dashboard/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest (metadata, hooks, skills)
├── hooks/
│   └── hooks.json               # HTTP hook definitions for 4 lifecycle events
├── server/
│   └── server.mjs               # Zero-dep Node.js HTTP + WebSocket server
├── ui/
│   └── dashboard.html           # Single-page dashboard (inline CSS/JS, dark theme)
├── skills/
│   └── dashboard/
│       └── SKILL.md             # /agent-dashboard:dashboard slash command
├── marketplace.json             # Marketplace catalog for plugin distribution
├── LICENSE                      # MIT
└── README.md                    # This file
```

## License

MIT
