---
name: dashboard
description: Start the Agent Dashboard server and open the real-time subagent status visualizer
user_invocable: true
---

# Agent Dashboard

Start the Agent Dashboard server to visualize subagent status in real-time.

## Instructions

1. Start the dashboard server by running this command:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/server.mjs"
   ```
   The server runs on port 8099 (override with `PORT` env var).

2. Tell the user the dashboard is available at **http://localhost:8099** and they should open it in their browser.

3. The dashboard will automatically receive events from Claude Code hooks when subagents are spawned, use tools, or finish. No additional configuration is needed — the plugin's hooks handle everything.

4. If port 8099 is already in use, the server will fail to start. Tell the user to either stop the existing process or set a different port:
   ```bash
   PORT=8100 node "${CLAUDE_PLUGIN_ROOT}/server/server.mjs"
   ```
