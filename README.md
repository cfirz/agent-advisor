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
/plugin marketplace add cfirz/agent-advisor

# Install the plugin (global — hooks activate for all projects)
/plugin install agent-advisor@cfir-claude-plugins
```

### Option B: Direct Install from GitHub

```bash
# Clone and install locally
git clone https://github.com/cfirz/agent-advisor.git
claude plugin install --plugin-dir ./agent-advisor --scope user
```

### Option C: Quick Install Script (Windows)

```bash
git clone https://github.com/cfirz/agent-advisor.git
cd agent-advisor
install.bat
```

`install.bat` delegates to `scripts/install.mjs`, which:

- Registers the plugin with Claude Code's plugin system (marketplace + installed-plugins list)
- Enables the plugin in `~/.claude/settings.json` for skill discovery
- Merges all nine hooks into `~/.claude/settings.json`, including the `SessionStart` auto-start command with the correct absolute path to `server.mjs`
- Installs both skills globally to `~/.claude/skills/` so they work from any project directory
- Removes any obsolete local skill directories left over from earlier installs

The script is idempotent — running it again updates existing entries rather than creating duplicates.

### Option D: Manual Hook Setup

If you prefer not to use the plugin system, add the hooks directly to your Claude Code settings.

**Global** (`~/.claude/settings.json`) — tracks all projects. Replace `/path/to/agent-advisor` with the absolute path where you cloned this repo:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "curl -s http://localhost:8099/api/state > /dev/null 2>&1 || node \"/path/to/agent-advisor/server/server.mjs\" &" },
        { "type": "http", "url": "http://localhost:8099/hooks/session-start" }
      ] }
    ],
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
    "SessionEnd": [
      { "hooks": [{ "type": "http", "url": "http://localhost:8099/hooks/session-end" }] }
    ]
  }
}
```

> **Important:** The `SessionStart` command must use the **absolute path** to `server.mjs`. Using `$CLAUDE_PROJECT_DIR` only works correctly when Claude Code is opened from inside the agent-advisor directory itself — it resolves to the current project's directory, not agent-advisor's. The `install.bat` script handles this automatically.

> If you already have hooks in your settings, merge these entries into the existing `hooks` object. Multiple hook entries for the same event are supported.

## Usage

### 1. Start the dashboard server

**Windows (recommended):** Run `start.bat` from the repo root. It kills any existing server on port 8099, starts a fresh one, and waits until the server is ready before returning:

```bat
start.bat
```

To stop the server without starting a new one:

```bat
stop_server.bat
```

**Manual:**

```bash
node /path/to/agent-advisor/server/server.mjs
```

The server starts on port 8099 by default. Override with:

```bash
PORT=9000 node /path/to/agent-advisor/server/server.mjs
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

Hooks must be registered **before starting** your Claude Code session (or before spawning agents). If you add hooks to `settings.json` mid-session, only agents spawned after that point will be tracked. **After installing or changing hooks, restart Claude Code** for the new settings to take effect. For best results:

1. Install the plugin or add hooks to settings
2. **Restart Claude Code**
3. Start the dashboard server (or let `SessionStart` auto-start it)
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
- Advisor system: accumulates per-agent metrics, stores suggestions, handles approve/dismiss; supports seven suggestion types with allowlist-based path validation (`validateSuggestionPath`) and write-or-append file handling (`writeSuggestionFile`)
- Persists advisor data (metrics + suggestions) to `.claude/advisor-data/`
- **Session archival**: sessions are snapshotted on `SessionEnd` and stored in `.claude/advisor-data/sessions.json` (max 50 per project); each record includes agents, activity log, per-agent-type metrics breakdown, and `skillCount`/`uniqueSkills` for analytics
- Filters temporary and internal projects (`.paperclip/instances/` paths, UUID-prefixed names, `_default`) from the projects list
- `DELETE /api/projects` endpoint removes a project from server state and persists the change
- `GET /api/sessions` — list all sessions (archived + active) for a project, sorted most-recent-first
- `GET /api/sessions/:id` — full detail for one session: agents snapshot, activity log, metrics breakdown
- `GET /api/advisor/metrics?session=SESSION_ID` — filters metrics to runs from a specific session

### Dashboard (`ui/dashboard.html`)
- Single HTML file with inline CSS and JavaScript
- Light/dark/auto theme toggle in the sidebar — "Auto" follows OS `prefers-color-scheme`; preference persists in `localStorage`
- Project tabs bar above the page content — click to switch projects, hover to reveal a close button that removes the project from the dashboard
- **Sessions list page** (`#/sessions`) — table of all recorded sessions with date, duration, agent count, tokens, and errors; updates in real time via `session-archived` WebSocket message
- **Session detail page** (`#/sessions/:id`) — three tabs: Agents (card grid), Activity (filtered log), Metrics (totals + per-agent breakdown table); works for both live and archived sessions
- **Session selector dropdown** on the main dashboard — switch between the live session and any historical session without leaving the page
- **Analytics page** (`#/analytics`) — Canvas-based multi-series line chart plotting session performance over time; no external dependencies
  - 5 tracked metrics: Agent Count, Skill Count, Total Tokens, Error Count, Session Duration
  - Metric toggle chips to show/hide individual series
  - Date range filter (from/to date inputs)
  - Dual Y-axes: left axis for counts, right axis for tokens and duration
  - Hover tooltips showing all metric values for a given session
  - Responsive redraw via `ResizeObserver`
  - Real-time updates on `session-archived` and `session-update` WebSocket events
  - Theme-aware canvas: redraws automatically when the light/dark theme is switched
- Session summary bar with duration, agent count, token usage, and error count
- Responsive CSS grid layout for agent cards with token counters
- Skills shown as purple tags, tools as orange tags on each card
- Agent Advisor panel with suggestion cards (approve/dismiss); badge styles and approve tooltips adapt to all seven suggestion types, including an append-preview diff for `improve-rules` suggestions targeting `CLAUDE.md`
- Dismissible idle cards with Clear button (re-appear when agent is active again)
- WebSocket connection with automatic reconnect + HTTP polling fallback
- Relative timestamps updated every second

### Hooks (`hooks/hooks.json`)
- Nine hooks covering the full agent lifecycle: start/stop, tool use (pre/post/failure), stop, notification, and session start/end
- `SessionStart` includes a command hook that auto-starts the server if not already running
- All HTTP hooks fail silently when the dashboard server is not running — no impact on Claude Code performance

## Agent Advisor

The dashboard includes an AI-powered advisor that analyzes subagent performance and suggests actionable improvements to your agent setup.

**How it works:**
1. Performance metrics (runs, tokens, errors, tool frequency) accumulate automatically as agents work
2. Run `/agent-advisor:advisor` in Claude Code to analyze metrics and generate suggestions
3. Suggestions appear in the Advisor panel in the dashboard with approve/dismiss buttons
4. Approving a suggestion writes or appends the proposed file automatically

**Suggestion types:**

| Type | What it does | Target path |
|------|-------------|-------------|
| `new-agent` | Creates a new subagent definition | `.claude/agents/<name>.md` |
| `improve-agent` | Updates an existing agent definition | `.claude/agents/<name>.md` |
| `improve-rules` | Appends delegation rules to the project rules file so the orchestrator knows when to use existing agents | `CLAUDE.md` (append mode) |
| `new-skill` | Creates a new slash command skill that chains agents into a workflow | `skills/<name>/SKILL.md` |
| `improve-skill` | Updates an existing skill | `skills/<name>/SKILL.md` |
| `new-command` | Creates a new command that invokes agents | `.claude/commands/<name>.md` |
| `improve-command` | Updates an existing command | `.claude/commands/<name>.md` |

**Underutilization detection:** The advisor cross-references `.claude/agents/` against collected metrics to find agents with zero or very few runs. For each underutilized agent it diagnoses why — missing delegation rules in `CLAUDE.md`, no skill or command entry point, or a description that doesn't match the orchestrator's actual work patterns — and proposes the most appropriate fix.

The advisor skill also performs cross-session analysis: it fetches session history via `GET /api/sessions`, compares trends across sessions (error rates, token usage, delegation ratio), and incorporates those trends into its suggestions.

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
- **In-memory agent state**: Agent cards and the current activity log reset when the server restarts. Advisor metrics, suggestions, and archived session history are persisted to disk and reloaded on restart.
- **No authentication**: The dashboard server has no auth. It binds to localhost only, which is fine for local development.
- **WebSocket proxy**: Some environments (e.g., Claude Code's preview tool) don't support WebSocket upgrade. The dashboard falls back to HTTP polling in these cases.

## Troubleshooting

**Dashboard shows "No agents yet" but agents are running**
- Hooks may not be registered. Check with `/hooks` in Claude Code to see active hooks.
- Hooks added mid-session only apply to newly spawned agents. Start a new session.
- Verify the dashboard server is running: `curl http://localhost:8099/api/state`

**Port 8099 is already in use**
- On Windows, just run `start.bat` — it kills the existing process and restarts cleanly.
- Manual kill:
  ```bash
  # Linux/Mac
  lsof -ti:8099 | xargs kill
  # Windows
  netstat -ano | findstr 8099
  taskkill /PID <pid> /F
  ```
- Or use a different port: `PORT=9000 node server/server.mjs`

**Dashboard only shows activity from the agent-advisor project, not other projects**
- The global `~/.claude/settings.json` may be missing the `SessionStart` hook or using `$CLAUDE_PROJECT_DIR` in the auto-start command. Re-run `install.bat` (Windows) or manually add the `SessionStart` hook with an absolute path to `server.mjs` as shown in Option D above.
- Restart Claude Code after updating hooks.

**Agent cards stuck on "Working"**
- The stale detection will mark them "Stale?" after 30s and auto-idle after 90s.
- If the `SubagentStop` hook doesn't fire (rare), this is the safety net.

## Files

```
agent-advisor/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest (metadata, hooks, skills)
├── hooks/
│   └── hooks.json               # HTTP hook definitions for 9 lifecycle events
├── scripts/
│   └── install.mjs              # Node.js install script (called by install.bat)
├── server/
│   └── server.mjs               # Zero-dep Node.js HTTP + WebSocket server
├── ui/
│   └── dashboard.html           # Single-page dashboard (inline CSS/JS, light/dark/auto theme)
├── skills/
│   ├── dashboard/
│   │   └── SKILL.md             # /agent-advisor:dashboard slash command
│   └── advisor/
│       └── SKILL.md             # /agent-advisor:advisor slash command
├── install.bat                  # Windows install (delegates to scripts/install.mjs)
├── start.bat                    # Windows script to start (or restart) the server
├── stop_server.bat              # Windows script to stop the server
├── marketplace.json             # Marketplace catalog for plugin distribution
├── privacy-policy.html          # Hosted privacy policy for GitHub Pages
├── CLAUDE.md                    # Project guidance for Claude Code
├── LICENSE                      # MIT
└── README.md                    # This file
```

## Contributing

Contributions are welcome. The project has no build step and zero dependencies — all you need is Node.js.

### Getting Started

```bash
git clone https://github.com/cfirz/agent-advisor.git
cd agent-advisor

# Install hooks into your own Claude Code settings
install.bat        # Windows
# or manually merge hooks/hooks.json into ~/.claude/settings.json

# Start the server
start.bat          # Windows
# or: node server/server.mjs

# Open the dashboard
# http://localhost:8099
```

### Project Conventions

- **No dependencies.** The server uses only Node.js built-ins (`http`, `crypto`, `fs/promises`, `path`, `url`, `os`). Don't add `package.json` or `node_modules`.
- **No build step.** The UI is a single self-contained `ui/dashboard.html` with inline CSS and JS. Keep it that way.
- **Server changes** go in `server/server.mjs`. To add human-readable descriptions for new tools, extend the `describeActivity()` function.
- **UI changes** go in `ui/dashboard.html`. Test with both WebSocket (normal) and polling fallback (disconnect WS to verify).
- **Hook changes** go in `hooks/hooks.json` and must be reflected in `scripts/install.mjs` and the Manual Hook Setup section of this README.

### Submitting a Pull Request

1. **Fork** the repo and create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes.** Keep commits focused — one logical change per commit.

3. **Test manually** before opening a PR:
   - Start the server (`start.bat` or `node server/server.mjs`)
   - Open the dashboard at `http://localhost:8099`
   - Run a Claude Code session with agents and verify your change behaves correctly
   - Check the browser console for errors

4. **Open a PR** against the `main` branch. In the PR description include:
   - What the change does and why
   - How you tested it
   - Screenshots or screen recordings for UI changes

### Good First Contributions

- New tool descriptions in `describeActivity()` (e.g., for MCP tools you use)
- UI improvements to the dashboard (agent cards, activity log, advisor panel)
- Linux/macOS install script (`install.sh`) equivalent to `install.bat`
- Additional hook event support

### Reporting Bugs

Open an issue at [github.com/cfirz/agent-advisor/issues](https://github.com/cfirz/agent-advisor/issues) with:
- What you expected vs. what happened
- Output of `curl http://localhost:8099/api/state`
- Your Node.js version (`node --version`)
- Relevant hook config from `~/.claude/settings.json`

## License

MIT
