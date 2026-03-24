# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A zero-dependency Claude Code plugin that provides a real-time web dashboard for visualizing subagent status and activity. Events flow from Claude Code hooks (HTTP POST) → Node.js server (port 8099) → WebSocket/polling → browser UI.

## Running the Server

```bash
node server/server.mjs
# Override default port: PORT=9000 node server/server.mjs
```

No build step, no npm install, no test framework. Pure vanilla JS/HTML with only Node.js built-in modules (`http`, `crypto`, `fs/promises`, `path`, `url`).

## Architecture

**Hook-based event streaming** with three layers:

1. **Hooks** (`hooks/hooks.json`) — 4 HTTP hooks registered with Claude Code: `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, all POST to `localhost:8099/hooks/*`

2. **Server** (`server/server.mjs`) — Stateful HTTP+WebSocket server. Maintains an `agents` Map (agent type → status/activity) and a circular `activityLog` buffer (max 100). Custom RFC 6455 WebSocket frame encoder/decoder (no library). Stale detection runs every 5s (30s → amber warning, 90s → auto-idle).

3. **UI** (`ui/dashboard.html`) — Single self-contained HTML file with inline CSS/JS. Dark theme (GitHub palette). Responsive grid of agent cards. WebSocket with exponential backoff reconnect, HTTP polling (2s) as fallback. Relative timestamps updated every 1s.

**Key design choice:** Multiple agents of the same type share one card (latest instance's status shown); the activity log tracks all instances individually.

## Plugin Structure

- `.claude-plugin/plugin.json` — Plugin manifest (hooks + skills references)
- `hooks/hooks.json` — Hook definitions pointing to server endpoints
- `server/server.mjs` — The entire backend (~420 lines)
- `ui/dashboard.html` — The entire frontend (~480 lines)
- `skills/dashboard/SKILL.md` — `/agent-dashboard:dashboard` slash command
- `marketplace.json` — Marketplace distribution metadata

## Agent State Lifecycle

```
idle → working (SubagentStart) → completed (SubagentStop) → idle (30s timeout)
                ↑ activity updates (PreToolUse/PostToolUse)
                ↑ stale detection (30s amber, 90s auto-idle)
```

## Extending Tool Descriptions

The `describeActivity()` function in `server/server.mjs` maps tool names/inputs to human-readable text. Add new tool mappings there when supporting additional tools.
