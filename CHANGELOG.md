# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Light/dark/auto theme toggle in the dashboard sidebar. "Auto" follows the OS `prefers-color-scheme` preference. The selected theme persists in `localStorage` and is applied before first paint to prevent a flash of the wrong theme.
- Smooth 0.3s transition animation when switching themes.
- All dashboard colors converted from hardcoded values to CSS custom properties, enabling correct theme switching across every component.
- Light theme uses a warm off-white palette (`#f5f5f7` base, `#ffffff` surface) for comfortable daytime use.

## [1.2.1] - 2026-04-04

### Changed

- Agent cards no longer show a redundant status dot or a separate error badge; status is conveyed by a left-border accent color instead of a glow effect.
- Skills and tools on agent cards are now collapsed into an expandable summary element rather than listed inline, reducing visual noise.
- Token counts are merged into the card footer row instead of occupying their own line.
- Session stats (Defined, Active, Spawned counts) moved from a collapsible grid into the session bar, making them always visible.
- Activity log height reduced and the log header is now sticky inline, keeping context visible while scrolling.
- Spacing tightened across the sidebar, agent grid, page content area, and advisor panel.

## [1.2.0] - 2026-04-04

### Added

- Project tabs now display a close button (visible on hover) that removes the project from the dashboard and server state via a new `DELETE /api/projects` endpoint.
- `isTempProject()` filter on the server suppresses internal and temporary projects (`.paperclip/instances/` paths, UUID-prefixed names, and `_default`) from the project tabs list.
- `privacy-policy.html` — self-contained privacy policy page for GitHub Pages, styled to match the dashboard dark theme. Confirms no data collection, all-local operation, and MIT license.
- Author URL field in `.claude-plugin/plugin.json`.
- Versioning & release tagging guidelines in `CLAUDE.md`.

### Changed

- Project tabs moved from the sidebar into the main content area, sitting above the page content where breadcrumbs previously appeared.
- Project tab background now uses `var(--bg-surface)` instead of `var(--sidebar-bg)` to match the main area.

### Removed

- Breadcrumb navigation bar removed from the main content area. Navigation context is now provided by the sidebar active state alone.

## [1.1.0] - 2026-04-04

### Added

- `scripts/install.mjs` — a proper Node.js install script that replaces the inline one-liner in `install.bat`. It registers the marketplace, writes the installed-plugins list, enables the plugin in `settings.json`, installs both skills to `~/.claude/skills/`, and cleans up the obsolete local `.claude/skills/advisor/` directory.
- `stop_server.bat` — Windows helper to stop any running server process on port 8099 without needing to hunt for the PID manually.
- `SessionStart` hook now POSTs to `/hooks/register-project` (with the current working directory) after auto-starting the server, enabling reliable cross-project monitoring from a single global install.

### Changed

- `install.bat` now delegates to `scripts/install.mjs` via `node` instead of embedding a minified one-liner. The script is idempotent and handles all nine hook events including `SessionStart`, `Stop`, `Notification`, `PostToolUseFailure`, and `SessionEnd` which the previous version missed.
- `start.bat` now waits for the server to become ready (polling `/api/state` up to 10 times) before reporting success, eliminating a race condition where the script exited before the server was accepting connections.
- Skills are now installed globally to `~/.claude/skills/` with absolute paths substituted in, so they work from any project directory.
