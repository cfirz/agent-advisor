# Agent Dashboard Plugin for Claude Code

Real-time web dashboard that visualizes Claude Code agent activity. See the main Orchestrator and all subagents, what tools and skills they're using, what files they're reading, what commands they're executing, and when they finish — all in a live-updating browser UI.

![Dashboard showing agent cards and activity log](https://img.shields.io/badge/status-working-brightgreen)

## How It Works

```
Claude Code hooks (HTTP POST) --> Dashboard Server (port 8099) --> WebSocket/Polling --> Browser
```

The plugin registers hooks for nine lifecycle events — `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`, `SessionStart`, and `SessionEnd`. When Claude Code uses tools or spawns subagents, hook events are POSTed to the dashboard server, which pushes real-time updates to connected browsers via WebSocket (with HTTP polling fallback). The `SessionStart` hook also auto-starts the server if it isn't already running.

The main Claude Code agent appears as **Orchestrator** in the dashboard, so you can see everything it does alongside its subagents.

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

### Option C: Quick Install Script (Windows)

```bash
git clone https://github.com/cfirz/claude-agent-dashboard.git
cd claude-agent-dashboard
install.bat
```

The script merges the required hooks into your global `~/.claude/settings.json`. It's idempotent — running it multiple times won't create duplicates.

### Option D: Manual Hook Setup

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
    ],
    "PostToolUseFailure": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/post-tool-use-failure" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/stop" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/notification" }] }
    ],
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "curl -s http://localhost:8099/api/state > /dev/null 2>&1 || node \"$CLAUDE_PROJECT_DIR/server/server.mjs\" &" },
        { "type": "http", "url": "http://localhost:8099/hooks/session-start" }
      ] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/session-end" }] }
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

Agent cards appear automatically as Claude Code works. Each card shows:
- **Agent name** and current status (Orchestrator for the main agent, named cards for subagents)
- **Current activity** (e.g., "Reading Scripts/Player/PlayerController.cs")
- **Skills used** — purple tags (e.g., `commit`, `simplify`, `review-pr`)
- **Tools used** — orange tags (e.g., `Read`, `Grep`, `Bash`, `Edit`)
- **Token usage** — input, output, and cache read counters
- **Error display** — errors are shown inline on the card when they occur
- **Tool count** and time since last activity

A **session summary bar** at the top tracks overall session stats: duration, total agents spawned, tokens in/out, and error count.

The activity log at the bottom shows a timestamped feed of all agent events, with skill usage highlighted in purple.

### 4. Clear idle agents

When an agent finishes and transitions to idle, a **Clear** button appears on its card. Click it to dismiss the card from the view. The card will reappear automatically if the agent becomes active again.

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
| **Idle** | Gray dot, default border, Clear button | No active session for this agent — can be dismissed |

## Activity Descriptions

The dashboard converts raw tool calls into human-readable descriptions:

| Tool | Example Display |
|------|----------------|
| `Skill` | Running skill: commit |
| `Read` | Reading Scripts/Player/PlayerController.cs |
| `Edit` | Editing Scripts/Core/GameManager.cs |
| `Write` | Writing Scripts/UI/NewPanel.cs |
| `Grep` | Searching: "PlayerController" |
| `Glob` | Finding files: **/*.cs |
| `Agent` | Spawning explore: Search auth patterns |
| `Bash` (npm test) | Running tests |
| `Bash` (npm run lint) | Running linter |
| `Bash` (git ...) | Git: status |
| MCP Unity tools | Recompiling Unity scripts / Inspecting Player / etc. |
| `WebSearch` | Web search: "unity animation" |
| Any other tool | Using ToolName |

## Architecture

### Server (`server/server.mjs`)
- Zero-dependency Node.js server using built-in `http`, `crypto`, `fs/promises`, `path`, `url`, and `os` modules
- Receives hook events via HTTP POST on `/hooks/*` endpoints
- Tracks the main agent as "orchestrator" (events with no `agent_type`)
- Maintains in-memory agent state with skills, tools, and token usage per agent
- Parses JSONL transcript files to extract token counts (input, output, cache)
- WebSocket push for real-time updates, with HTTP polling fallback (`/api/state`)
- Stale agent detection: 30s no events = amber warning, 90s = auto-idle
- Skills and tools are cleared when an agent returns to idle
- Advisor system: accumulates per-agent metrics, stores suggestions, handles approve/dismiss
- Persists advisor data (metrics + suggestions) to `.claude/advisor-data/`

### Dashboard (`ui/dashboard.html`)
- Single HTML file with inline CSS and JavaScript
- Dark theme (GitHub dark palette)
- Session summary bar with duration, agent count, token usage, and error count
- Responsive CSS grid layout for agent cards with token counters
- Skills shown as purple tags, tools as orange tags on each card
- Agent Advisor panel with suggestion cards (approve/dismiss)
- Dismissible idle cards with Clear button (re-appear when agent is active again)
- WebSocket connection with automatic reconnect + HTTP polling fallback
- Relative timestamps updated every second

### Hooks (`hooks/hooks.json`)
- Nine hooks covering the full agent lifecycle: start/stop, tool use (pre/post/failure), stop, notification, and session start/end
- `SessionStart` includes a command hook that auto-starts the server if not already running
- All HTTP hooks fail silently when the dashboard server is not running — no impact on Claude Code performance

## Agent Advisor

The dashboard includes an AI-powered advisor that analyzes subagent performance and suggests new agents or improvements to existing ones.

**How it works:**
1. Performance metrics (runs, tokens, errors, tool frequency) accumulate automatically as agents work
2. Run `/agent-dashboard:advisor` in Claude Code to analyze metrics and generate suggestions
3. Suggestions appear in the Advisor panel in the dashboard with approve/dismiss buttons
4. Approving a suggestion writes the agent `.md` file to `.claude/agents/` automatically

Metrics and suggestions are persisted to `.claude/advisor-data/` and survive server restarts.

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
- **In-memory agent state**: Agent cards and the activity log reset when the server restarts. Advisor metrics and suggestions are persisted to disk.
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
│   └── hooks.json               # HTTP hook definitions for 9 lifecycle events
├── server/
│   └── server.mjs               # Zero-dep Node.js HTTP + WebSocket server
├── ui/
│   └── dashboard.html           # Single-page dashboard (inline CSS/JS, dark theme)
├── skills/
│   ├── dashboard/
│   │   └── SKILL.md             # /agent-dashboard:dashboard slash command
│   └── advisor/
│       └── SKILL.md             # /agent-dashboard:advisor slash command
├── install.bat                  # Windows quick-install script for hooks
├── marketplace.json             # Marketplace catalog for plugin distribution
├── CLAUDE.md                    # Project guidance for Claude Code
├── LICENSE                      # MIT
└── README.md                    # This file
```

## License

MIT
