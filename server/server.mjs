#!/usr/bin/env node
// Agent Dashboard Server — zero dependencies, Node.js built-in only
// Receives Claude Code hook events via HTTP POST, serves dashboard UI,
// and pushes real-time updates to browsers via WebSocket.
// Supports multiple projects (workspaces) — each project gets isolated state.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { join, dirname, resolve, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8099', 10);
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB9A3F8D85E';
const PLUGIN_ROOT = resolve(__dirname, '..');
const PLUGIN_ADVISOR_DIR = join(PLUGIN_ROOT, '.claude', 'advisor-data');
const PROJECTS_REGISTRY_PATH = join(PLUGIN_ADVISOR_DIR, 'projects.json');

const ORCHESTRATOR = 'orchestrator';
const MAX_LOG = 100;
const MAX_RUNS_PER_AGENT = 20;
const MAX_SESSIONS = 50;

// --- Multi-Project State ---

const projects = new Map();          // normalizedCwd -> ProjectState
const sessionToProject = new Map();  // sessionId -> normalizedCwd
const wsClients = new Set();

function normalizeCwd(cwd) {
  if (!cwd) return '';
  let normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  // Convert Git Bash paths (/e/foo) to Windows-style (E:/foo)
  const gitBashMatch = normalized.match(/^\/([a-zA-Z])\/(.*)/);
  if (gitBashMatch) {
    normalized = gitBashMatch[1].toUpperCase() + ':/' + gitBashMatch[2];
  }
  return normalized;
}

/**
 * If `normalizedCwd` is inside a .claude/worktrees/ directory, return the parent project cwd.
 * E.g. "E:/UnityProjects/my-project/.claude/worktrees/agent-a5e04294"
 *   -> "E:/UnityProjects/my-project"
 * Returns null if not a worktree path.
 */
function resolveWorktreeParentCwd(normalizedCwd) {
  const idx = normalizedCwd.indexOf('/.claude/worktrees/');
  return idx === -1 ? null : normalizedCwd.substring(0, idx);
}

// --- ProjectState Class ---

class ProjectState {
  constructor(cwd) {
    this.cwd = cwd;
    this.name = basename(cwd) || cwd;
    this.lastSeen = Date.now();

    // Per-project directories
    this.advisorDir = join(cwd.replace(/\//g, (process.platform === 'win32' ? '\\' : '/')), '.claude', 'advisor-data');
    this.metricsPath = join(this.advisorDir, 'metrics.json');
    this.suggestionsPath = join(this.advisorDir, 'suggestions.json');
    this.agentsDir = join(cwd.replace(/\//g, (process.platform === 'win32' ? '\\' : '/')), '.claude', 'agents');

    // Runtime state
    this.agents = new Map();
    this.activityLog = [];
    this.activeAgentIds = new Map();
    this.agentStartTimes = new Map();

    this.sessionState = {
      sessionId: null,
      startTime: null,
      totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      totalErrors: 0,
      agentCount: 0,
      skillCount: 0,
      uniqueSkills: [],
    };

    // Metrics & suggestions
    this.metrics = {
      version: 1, lastUpdated: null, agentTypes: {},
      orchestratorStats: { totalTurns: 0, toolFrequency: {}, agentTypesSpawned: [] },
    };
    this.suggestions = new Map();
    this._metricsSaveTimer = null;
    this._suggestionsSaveTimer = null;

    // Session history
    this.sessionHistory = [];
    this.sessionsPath = join(this.advisorDir, 'sessions.json');
    this._sessionsSaveTimer = null;
  }

  // --- Persistence ---

  async ensureAdvisorDir() {
    if (!existsSync(this.advisorDir)) await mkdir(this.advisorDir, { recursive: true });
  }

  async loadMetrics() {
    try {
      const raw = await readFile(this.metricsPath, 'utf8');
      this.metrics = JSON.parse(raw);
    } catch { /* file missing or corrupt — use defaults */ }
  }

  saveMetricsDebounced() {
    if (this._metricsSaveTimer) clearTimeout(this._metricsSaveTimer);
    this._metricsSaveTimer = setTimeout(async () => {
      try {
        await this.ensureAdvisorDir();
        this.metrics.lastUpdated = new Date().toISOString();
        await writeFile(this.metricsPath, JSON.stringify(this.metrics, null, 2));
      } catch (e) { console.error(`Failed to save metrics for ${this.name}:`, e.message); }
    }, 500);
  }

  async loadSuggestions() {
    try {
      const raw = await readFile(this.suggestionsPath, 'utf8');
      const arr = JSON.parse(raw);
      for (const s of arr) this.suggestions.set(s.id, s);
    } catch { /* file missing or corrupt */ }
  }

  saveSuggestionsDebounced() {
    if (this._suggestionsSaveTimer) clearTimeout(this._suggestionsSaveTimer);
    this._suggestionsSaveTimer = setTimeout(async () => {
      try {
        await this.ensureAdvisorDir();
        const arr = [...this.suggestions.values()];
        await writeFile(this.suggestionsPath, JSON.stringify(arr, null, 2));
      } catch (e) { console.error(`Failed to save suggestions for ${this.name}:`, e.message); }
    }, 500);
  }

  async loadSessions() {
    try {
      const raw = await readFile(this.sessionsPath, 'utf8');
      this.sessionHistory = JSON.parse(raw);
    } catch { /* file missing or corrupt — start empty */ }
  }

  saveSessionsDebounced() {
    if (this._sessionsSaveTimer) clearTimeout(this._sessionsSaveTimer);
    this._sessionsSaveTimer = setTimeout(async () => {
      try {
        await this.ensureAdvisorDir();
        await writeFile(this.sessionsPath, JSON.stringify(this.sessionHistory, null, 2));
      } catch (e) { console.error(`Failed to save sessions for ${this.name}:`, e.message); }
    }, 500);
  }

  // --- Agent State ---

  agentKey(agentType, agentId) {
    if (agentType === ORCHESTRATOR || !agentId) return agentType || ORCHESTRATOR;
    return `${agentType}::${agentId}`;
  }

  getAgentState(key, agentType) {
    if (!this.agents.has(key)) {
      this.agents.set(key, {
        agentType: agentType || key,
        status: 'idle',
        activity: '',
        lastSeen: null,
        toolCount: 0,
        agentId: null,
        stale: false,
        skills: [],
        tools: [],
        errors: 0,
        lastError: null,
        tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      });
    }
    return this.agents.get(key);
  }

  resolveToolAgentKey(body) {
    const agentType = body.agent_type || ORCHESTRATOR;
    const agentId = body.agent_id || this.activeAgentIds.get(agentType) || null;
    return { key: this.agentKey(agentType, agentId), agentType };
  }

  fullState() {
    const obj = {};
    for (const [key, val] of this.agents) obj[key] = { ...val };
    const sugg = [...this.suggestions.values()];
    return { agents: obj, activityLog: this.activityLog.slice(), session: { ...this.sessionState }, suggestions: sugg, sessionCount: this.sessionHistory.length };
  }

  pushLog(displayName, message, level = 'info') {
    const entry = { time: Date.now(), agent: displayName, message, level };
    this.activityLog.push(entry);
    if (this.activityLog.length > MAX_LOG) this.activityLog.shift();
    this.broadcast({ type: 'activity', data: entry });
  }

  broadcast(msg) {
    const frame = encodeWSFrame(JSON.stringify({ ...msg, projectId: this.cwd }));
    for (const socket of wsClients) {
      try { socket.write(frame); } catch { wsClients.delete(socket); }
    }
  }

  // --- Metrics ---

  recordAgentRun(agentType, agentData, durationMs) {
    if (!this.metrics.agentTypes[agentType]) {
      this.metrics.agentTypes[agentType] = {
        totalRuns: 0, totalToolCalls: 0, totalErrors: 0,
        totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        toolFrequency: {}, runs: [],
      };
    }
    const m = this.metrics.agentTypes[agentType];
    m.totalRuns++;
    m.totalToolCalls += agentData.toolCount || 0;
    m.totalErrors += agentData.errors || 0;
    const t = agentData.tokens || {};
    m.totalTokens.input += t.input || 0;
    m.totalTokens.output += t.output || 0;
    m.totalTokens.cacheCreation += t.cacheCreation || 0;
    m.totalTokens.cacheRead += t.cacheRead || 0;
    for (const tool of (agentData.tools || [])) {
      m.toolFrequency[tool] = (m.toolFrequency[tool] || 0) + 1;
    }
    m.runs.push({
      timestamp: new Date().toISOString(),
      sessionId: this.sessionState.sessionId || null,
      toolCount: agentData.toolCount || 0,
      errors: agentData.errors || 0,
      tokens: { ...t },
      tools: [...(agentData.tools || [])],
      skills: [...(agentData.skills || [])],
      durationMs: durationMs || 0,
    });
    if (m.runs.length > MAX_RUNS_PER_AGENT) m.runs.shift();
    const os = this.metrics.orchestratorStats;
    if (!os.agentTypesSpawned.includes(agentType)) {
      os.agentTypesSpawned.push(agentType);
    }
    this.saveMetricsDebounced();
  }

  trackOrchestratorTool(toolName) {
    const os = this.metrics.orchestratorStats;
    os.toolFrequency[toolName] = (os.toolFrequency[toolName] || 0) + 1;
  }

  // --- Suggestion file helpers ---

  static VALID_SUGGESTION_TYPES = new Set([
    'new-agent', 'improve-agent',
    'improve-rules',
    'new-skill', 'improve-skill',
    'new-command', 'improve-command',
  ]);

  validateSuggestionPath(type, relativePath) {
    const nativeCwd = this.cwd.replace(/\//g, (process.platform === 'win32' ? '\\' : '/'));
    const fullPath = resolve(nativeCwd, relativePath);
    const projectRoot = resolve(nativeCwd);
    // Must stay within project root (traversal prevention)
    if (!fullPath.startsWith(projectRoot)) return false;

    const normed = relativePath.replace(/\\/g, '/');
    switch (type) {
      case 'new-agent':
      case 'improve-agent':
        return /^\.claude\/agents\/[^/]+\.md$/.test(normed);
      case 'improve-rules':
        return normed === 'CLAUDE.md';
      case 'new-skill':
      case 'improve-skill':
        return /^skills\/[^/]+\/SKILL\.md$/.test(normed);
      case 'new-command':
      case 'improve-command':
        return /^\.claude\/commands\/[^/]+\.md$/.test(normed);
      default:
        return false;
    }
  }

  async writeSuggestionFile(suggestion) {
    const filePath = suggestion.proposedFile?.path;
    if (!filePath) throw new Error('No file path in suggestion');
    const nativeCwd = this.cwd.replace(/\//g, (process.platform === 'win32' ? '\\' : '/'));
    const fullPath = resolve(nativeCwd, filePath);
    if (!this.validateSuggestionPath(suggestion.type, filePath)) {
      throw new Error(`Invalid path for type "${suggestion.type}": ${filePath}`);
    }
    await mkdir(dirname(fullPath), { recursive: true });
    const tmpPath = fullPath + '.tmp.' + randomBytes(4).toString('hex');

    if (suggestion.type === 'improve-rules') {
      // Append mode for CLAUDE.md — don't overwrite the whole file
      let existing = '';
      try { existing = await readFile(fullPath, 'utf8'); } catch { /* file doesn't exist yet */ }
      const combined = existing ? existing.trimEnd() + '\n\n' + suggestion.proposedFile.content : suggestion.proposedFile.content;
      await writeFile(tmpPath, combined);
    } else {
      await writeFile(tmpPath, suggestion.proposedFile.content);
    }

    await rename(tmpPath, fullPath);
    return fullPath;
  }

  async listAgentDefinitions() {
    try {
      const files = await readdir(this.agentsDir);
      const defs = [];
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        try {
          const content = await readFile(join(this.agentsDir, file), 'utf8');
          const parsed = parseAgentFile(content);
          const name = parsed.frontmatter.name || file.replace(/\.md$/, '');
          let liveStatus = 'idle';
          for (const [, agent] of this.agents) {
            if (agent.agentType === name && (agent.status === 'working' || agent.status === 'completed')) {
              liveStatus = agent.status;
              break;
            }
          }
          defs.push({
            fileName: file,
            name,
            description: parsed.frontmatter.description || '',
            tools: parsed.frontmatter.tools || [],
            model: parsed.frontmatter.model || '',
            body: parsed.body,
            liveStatus,
          });
        } catch { /* skip unreadable files */ }
      }
      defs.sort((a, b) => a.name.localeCompare(b.name));
      return defs;
    } catch { return []; }
  }

  // --- Stale detection ---

  checkStaleAgents() {
    const now = Date.now();
    for (const [key, agent] of this.agents) {
      if (agent.status === 'working' && agent.lastSeen) {
        const age = now - agent.lastSeen;
        if (age > 90_000) {
          agent.status = 'idle';
          agent.activity = '';
          agent.skills = [];
          agent.tools = [];
          this.broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
          this.pushLog(agent.agentType || key, 'No events for 90s — marked idle');
        } else if (age > 30_000 && !agent.stale) {
          agent.stale = true;
          this.broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
        }
      }
    }
  }
}

// --- Shared parsers (not project-scoped) ---

function parseAgentFile(content) {
  const result = { frontmatter: { name: '', description: '', tools: [], model: '' }, body: '' };
  if (!content || !content.startsWith('---')) {
    result.body = content || '';
    return result;
  }
  const secondDash = content.indexOf('---', 3);
  if (secondDash === -1) { result.body = content; return result; }
  const fmBlock = content.slice(3, secondDash).trim();
  result.body = content.slice(secondDash + 3).replace(/^\n+/, '');
  for (const line of fmBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key === 'tools') {
      result.frontmatter.tools = val.split(',').map(t => t.trim()).filter(Boolean);
    } else {
      result.frontmatter[key] = val;
    }
  }
  return result;
}

function buildAgentFileContent(data) {
  const fm = [
    '---',
    `name: ${data.name}`,
    `description: ${data.description || ''}`,
    `tools: ${(data.tools || []).join(', ')}`,
  ];
  if (data.model) fm.push(`model: ${data.model}`);
  fm.push('---', '');
  return fm.join('\n') + (data.body || '');
}

// --- Project Registry ---

async function ensurePluginAdvisorDir() {
  if (!existsSync(PLUGIN_ADVISOR_DIR)) await mkdir(PLUGIN_ADVISOR_DIR, { recursive: true });
}

async function loadProjectsRegistry() {
  try {
    const raw = await readFile(PROJECTS_REGISTRY_PATH, 'utf8');
    const arr = JSON.parse(raw);
    for (const entry of arr) {
      const cwd = normalizeCwd(entry.cwd);
      if (!cwd) continue;
      // Skip worktree entries — they'll be resolved to parent on next event
      if (resolveWorktreeParentCwd(cwd)) continue;
      if (!projects.has(cwd)) {
        const proj = new ProjectState(cwd);
        proj.lastSeen = entry.lastSeen || 0;
        if (entry.name) proj.name = entry.name;
        projects.set(cwd, proj);
      }
    }
  } catch { /* file missing — start fresh */ }
}

async function saveProjectsRegistry() {
  try {
    await ensurePluginAdvisorDir();
    const arr = [];
    for (const [cwd, proj] of projects) {
      arr.push({ cwd, name: proj.name, lastSeen: proj.lastSeen });
    }
    await writeFile(PROJECTS_REGISTRY_PATH, JSON.stringify(arr, null, 2));
  } catch (e) { console.error('Failed to save projects registry:', e.message); }
}

async function getOrCreateProject(cwd) {
  let normalized = normalizeCwd(cwd);
  if (!normalized) return null;
  // Redirect worktree paths to parent project
  const parentCwd = resolveWorktreeParentCwd(normalized);
  if (parentCwd) normalized = parentCwd;
  if (projects.has(normalized)) {
    const proj = projects.get(normalized);
    proj.lastSeen = Date.now();
    return proj;
  }
  const proj = new ProjectState(normalized);
  projects.set(normalized, proj);
  await proj.ensureAdvisorDir();
  await proj.loadMetrics();
  await proj.loadSuggestions();
  await proj.loadSessions();
  await saveProjectsRegistry();
  // Notify UI of new project
  broadcastGlobal({ type: 'projects-update', data: getProjectsList() });
  return proj;
}

function resolveProject(body) {
  // Try session_id mapping first
  if (body.session_id && sessionToProject.has(body.session_id)) {
    const cwd = sessionToProject.get(body.session_id);
    return projects.get(cwd) || null;
  }
  // Try cwd in body
  if (body.cwd) {
    const normalized = normalizeCwd(body.cwd);
    const direct = projects.get(normalized);
    if (direct) return direct;
    // Worktree path? Resolve to parent project
    const parentCwd = resolveWorktreeParentCwd(normalized);
    if (parentCwd) {
      const parentProj = projects.get(parentCwd);
      if (parentProj) {
        // Cache session mapping so subsequent events fast-path
        if (body.session_id) sessionToProject.set(body.session_id, parentCwd);
        return parentProj;
      }
    }
  }
  // Fallback: if only one project, use it
  if (projects.size === 1) {
    return projects.values().next().value;
  }
  return null;
}

const TEMP_PROJECT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

function isTempProject(cwd, name) {
  if (cwd.includes('.paperclip/instances/')) return true;
  if (cwd.includes('/.claude/worktrees/')) return true;
  if (TEMP_PROJECT_RE.test(name)) return true;
  if (name === '_default') return true;
  return false;
}

function getProjectsList() {
  const list = [];
  for (const [cwd, proj] of projects) {
    if (isTempProject(cwd, proj.name)) continue;
    let hasActiveSession = false;
    for (const [, pCwd] of sessionToProject) {
      if (pCwd === cwd) { hasActiveSession = true; break; }
    }
    let hasActiveAgents = false;
    for (const [, agent] of proj.agents) {
      if (agent.status === 'working') { hasActiveAgents = true; break; }
    }
    list.push({ id: cwd, name: proj.name, cwd, lastSeen: proj.lastSeen, hasActiveSession, hasActiveAgents });
  }
  return list;
}

// --- Shared Helper Functions ---

function shortPath(filePath) {
  if (!filePath) return 'file';
  const normalized = filePath.replace(/\\/g, '/');
  const stripped = normalized
    .replace(/^.*?\/RunnerGame\//i, '')
    .replace(/RunnerGameClient\//g, 'Client/')
    .replace(/RunnerGameServer\//g, 'Server/')
    .replace(/Assets\/_Project\//g, '');
  const parts = stripped.split('/');
  return parts.length > 3 ? '...' + parts.slice(-3).join('/') : stripped;
}

function trunc(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function describeActivity(toolName, toolInput) {
  if (!toolName) return '';
  const input = toolInput || {};

  if (toolName === 'Skill') return `Running skill: ${input.skill || 'unknown'}`;
  if (toolName === 'Read') return `Reading ${shortPath(input.file_path)}`;
  if (toolName === 'Write') return `Writing ${shortPath(input.file_path)}`;
  if (toolName === 'Edit') return `Editing ${shortPath(input.file_path)}`;
  if (toolName === 'Glob') return `Finding files: ${trunc(input.pattern, 40)}`;
  if (toolName === 'Grep') return `Searching: "${trunc(input.pattern, 30)}"`;
  if (toolName === 'WebSearch') return `Web search: "${trunc(input.query, 40)}"`;
  if (toolName === 'WebFetch') return `Fetching ${trunc(input.url, 50)}`;
  if (toolName === 'TodoWrite') return 'Updating task list';
  if (toolName === 'Agent') return `Spawning ${input.subagent_type || 'agent'}: ${trunc(input.description, 40)}`;

  if (toolName === 'Bash') {
    const cmd = input.command || '';
    if (cmd.match(/^npm run lint/)) return 'Running linter';
    if (cmd.match(/^npm run typecheck/)) return 'Running type checker';
    if (cmd.match(/^npm test/)) return 'Running tests';
    if (cmd.match(/^npm run build/)) return 'Building project';
    if (cmd.match(/^git\s/)) return `Git: ${trunc(cmd.slice(4), 40)}`;
    if (cmd.match(/^npx prisma/)) return `Prisma: ${trunc(cmd.slice(11), 40)}`;
    if (cmd.match(/^node\s/)) return `Node: ${trunc(cmd.slice(5), 40)}`;
    return `Running: ${trunc(cmd, 50)}`;
  }

  if (toolName.startsWith('mcp__mcp-unity__')) {
    const action = toolName.replace('mcp__mcp-unity__', '');
    const target = input.objectPath || input.objectName || input.sceneName || input.prefabName || input.name || '';
    const map = {
      get_gameobject: `Inspecting ${target}`,
      update_gameobject: `Updating ${target}`,
      update_component: `Modifying component on ${target}`,
      create_prefab: `Creating prefab ${target}`,
      create_scene: `Creating scene ${target}`,
      save_scene: 'Saving scene',
      load_scene: `Loading scene ${target}`,
      recompile_scripts: 'Recompiling Unity scripts',
      run_tests: 'Running Unity tests',
      get_console_logs: 'Reading Unity console',
      get_scene_info: 'Getting scene info',
      create_material: `Creating material ${target}`,
      batch_execute: 'Batch Unity operations',
      delete_gameobject: `Deleting ${target}`,
      move_gameobject: `Moving ${target}`,
      rotate_gameobject: `Rotating ${target}`,
      scale_gameobject: `Scaling ${target}`,
      duplicate_gameobject: `Duplicating ${target}`,
    };
    return map[action] || `Unity: ${action.replace(/_/g, ' ')}`;
  }

  return `Using ${toolName}`;
}

// --- Token Parsing ---

async function parseTranscriptTokens(filePath) {
  const tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const obj = JSON.parse(line);
        const usage = obj.message?.usage;
        if (usage) {
          tokens.input += usage.input_tokens || 0;
          tokens.output += usage.output_tokens || 0;
          tokens.cacheCreation += usage.cache_creation_input_tokens || 0;
          tokens.cacheRead += usage.cache_read_input_tokens || 0;
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file not found or unreadable */ }
  return tokens;
}

function buildTranscriptPath(sessionId, agentId, cwd) {
  if (!sessionId || !agentId) return null;
  const cwdNorm = (cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
  const slug = cwdNorm.replace(/[/:]/g, '-').replace(/^-+/, '');
  return join(homedir(), '.claude', 'projects', slug, sessionId, 'subagents', `agent-a${agentId}.jsonl`);
}

// --- Hook Handlers (project-scoped) ---

function handleSubagentStart(proj, body) {
  const agentType = body.agent_type;
  if (!agentType) return;
  const agentId = body.agent_id || null;
  const key = proj.agentKey(agentType, agentId);

  if (agentId) proj.activeAgentIds.set(agentType, agentId);

  const agent = proj.getAgentState(key, agentType);
  agent.agentType = agentType;
  agent.status = 'working';
  agent.activity = 'Starting up...';
  agent.lastSeen = Date.now();
  agent.toolCount = 0;
  agent.agentId = agentId;
  agent.stale = false;
  agent.skills = [];
  agent.tools = [];
  agent.errors = 0;
  agent.lastError = null;
  agent.tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

  if (body.session_id && !proj.sessionState.sessionId) {
    proj.sessionState.sessionId = body.session_id;
  }
  proj.sessionState.agentCount++;

  proj.broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
  proj.broadcast({ type: 'session-update', data: { ...proj.sessionState } });

  proj.agentStartTimes.set(key, Date.now());

  const idSuffix = agentId ? ` (${agentId.slice(-6)})` : '';
  proj.pushLog(agentType, `Started${idSuffix}`);
}

async function handleSubagentStop(proj, body) {
  const agentType = body.agent_type;
  if (!agentType) return;
  const agentId = body.agent_id || proj.activeAgentIds.get(agentType) || null;
  const key = proj.agentKey(agentType, agentId);
  const agent = proj.getAgentState(key, agentType);
  agent.status = 'completed';
  agent.activity = 'Finished';
  agent.lastSeen = Date.now();

  let transcriptPath = body.agent_transcript_path || null;
  if (!transcriptPath) {
    transcriptPath = buildTranscriptPath(proj.sessionState.sessionId || body.session_id, agent.agentId, body.cwd || proj.cwd);
  }
  if (transcriptPath) {
    const tokens = await parseTranscriptTokens(transcriptPath);
    agent.tokens = tokens;
    const totalIn = tokens.input + tokens.cacheCreation + tokens.cacheRead;
    const totalOut = tokens.output;
    proj.sessionState.totalTokens.input += tokens.input;
    proj.sessionState.totalTokens.output += tokens.output;
    proj.sessionState.totalTokens.cacheCreation += tokens.cacheCreation;
    proj.sessionState.totalTokens.cacheRead += tokens.cacheRead;
    proj.broadcast({ type: 'session-update', data: { ...proj.sessionState } });
    if (totalIn > 0 || totalOut > 0) {
      proj.pushLog(agentType, `Tokens: ${formatTokenCount(totalIn)} in / ${formatTokenCount(totalOut)} out`);
    }
  }

  proj.broadcast({ type: 'agent-update', agent: key, data: { ...agent } });

  const startTime = proj.agentStartTimes.get(key);
  const durationMs = startTime ? Date.now() - startTime : 0;
  proj.agentStartTimes.delete(key);
  proj.recordAgentRun(agentType, agent, durationMs);

  const skillsSuffix = agent.skills.length ? `, skills: ${agent.skills.join(', ')}` : '';
  const idSuffix = agent.agentId ? ` (${agent.agentId.slice(-6)})` : '';
  proj.pushLog(agentType, `Completed${idSuffix} (${agent.toolCount} tools used${skillsSuffix})`);

  if (agentId && proj.activeAgentIds.get(agentType) === agentId) {
    proj.activeAgentIds.delete(agentType);
  }

  const capturedKey = key;
  setTimeout(() => {
    if (agent.status === 'completed') {
      agent.status = 'idle';
      agent.activity = '';
      agent.skills = [];
      agent.tools = [];
      proj.broadcast({ type: 'agent-update', agent: capturedKey, data: { ...agent } });
    }
  }, 30_000);
}

function handlePreToolUse(proj, body) {
  const { key, agentType } = proj.resolveToolAgentKey(body);
  const agent = proj.getAgentState(key, agentType);
  const toolName = body.tool_name || '';
  let toolInput = body.tool_input;
  if (typeof toolInput === 'string') {
    try { toolInput = JSON.parse(toolInput); } catch { toolInput = {}; }
  }
  const activity = describeActivity(toolName, toolInput);
  agent.activity = activity;
  agent.lastSeen = Date.now();
  agent.toolCount++;
  if (toolName === 'Skill') {
    const skillName = toolInput?.skill;
    if (skillName && !agent.skills.includes(skillName)) {
      agent.skills.push(skillName);
    }
    if (skillName && !proj.sessionState.uniqueSkills.includes(skillName)) {
      proj.sessionState.uniqueSkills.push(skillName);
      proj.sessionState.skillCount++;
    }
  } else if (toolName && !agent.tools.includes(toolName)) {
    agent.tools.push(toolName);
  }
  agent.stale = false;
  if (agent.status !== 'working') agent.status = 'working';
  proj.broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
  proj.pushLog(agentType, activity);
  if (toolName) proj.trackOrchestratorTool(toolName);
}

function handlePostToolUse(proj, body) {
  const { key } = proj.resolveToolAgentKey(body);
  const agent = proj.agents.get(key);
  if (agent) {
    agent.lastSeen = Date.now();
  }
}

function handlePostToolUseFailure(proj, body) {
  const { key, agentType } = proj.resolveToolAgentKey(body);
  const agent = proj.getAgentState(key, agentType);
  agent.lastSeen = Date.now();
  agent.errors++;
  const toolName = body.tool_name || 'unknown';
  const errorMsg = body.error || body.tool_result || 'Unknown error';
  agent.lastError = { tool: toolName, message: trunc(String(errorMsg), 200), time: Date.now() };
  proj.sessionState.totalErrors++;
  proj.broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
  proj.broadcast({ type: 'session-update', data: { ...proj.sessionState } });
  proj.pushLog(agentType, `FAILED: ${toolName} — ${trunc(String(errorMsg), 100)}`, 'error');
}

function handleStop(proj, body) {
  // Ignore Stop from worktree subagents — parent's SubagentStop handles completion
  const normalized = normalizeCwd(body.cwd || '');
  if (resolveWorktreeParentCwd(normalized)) return;

  const agent = proj.getAgentState(ORCHESTRATOR, ORCHESTRATOR);
  agent.status = 'completed';
  agent.activity = 'Turn finished';
  agent.lastSeen = Date.now();
  proj.broadcast({ type: 'agent-update', agent: ORCHESTRATOR, data: { ...agent } });
  const reason = body.stop_reason || body.reason || 'end_turn';
  proj.pushLog(ORCHESTRATOR, `Turn completed (${reason})`);
  proj.metrics.orchestratorStats.totalTurns++;
  proj.saveMetricsDebounced();
  setTimeout(() => {
    if (agent.status === 'completed') {
      agent.status = 'idle';
      agent.activity = '';
      proj.broadcast({ type: 'agent-update', agent: ORCHESTRATOR, data: { ...agent } });
    }
  }, 30_000);
}

function handleNotification(proj, body) {
  const message = body.message || body.notification || body.title || 'Notification';
  proj.pushLog('system', trunc(String(message), 200), 'notification');
}

function archiveCurrentSession(proj) {
  if (!proj.sessionState.sessionId) return;

  const record = {
    sessionId: proj.sessionState.sessionId,
    startTime: proj.sessionState.startTime,
    endTime: Date.now(),
    duration: proj.sessionState.startTime ? Date.now() - proj.sessionState.startTime : null,
    status: 'ended',
    agents: {},
    activityLog: proj.activityLog.slice(),
    metrics: {
      totalTokens: { ...proj.sessionState.totalTokens },
      totalErrors: proj.sessionState.totalErrors,
      agentCount: proj.sessionState.agentCount,
      skillCount: proj.sessionState.skillCount,
      uniqueSkills: [...proj.sessionState.uniqueSkills],
      agentBreakdown: {},
    },
  };

  // Snapshot agent states
  for (const [key, agent] of proj.agents) {
    record.agents[key] = { ...agent, tokens: { ...agent.tokens } };
    if (agent.lastError) record.agents[key].lastError = { ...agent.lastError };
  }

  // Build per-agentType breakdown
  for (const [, agent] of proj.agents) {
    const aType = agent.agentType || 'unknown';
    if (!record.metrics.agentBreakdown[aType]) {
      record.metrics.agentBreakdown[aType] = {
        runs: 0, toolCalls: 0, errors: 0,
        tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        durationMs: 0,
      };
    }
    const bd = record.metrics.agentBreakdown[aType];
    bd.runs++;
    bd.toolCalls += agent.toolCount || 0;
    bd.errors += agent.errors || 0;
    bd.tokens.input += agent.tokens?.input || 0;
    bd.tokens.output += agent.tokens?.output || 0;
    bd.tokens.cacheCreation += agent.tokens?.cacheCreation || 0;
    bd.tokens.cacheRead += agent.tokens?.cacheRead || 0;
  }

  proj.sessionHistory.push(record);
  while (proj.sessionHistory.length > MAX_SESSIONS) proj.sessionHistory.shift();
  proj.saveSessionsDebounced();

  // Broadcast lightweight summary (no activityLog or full agents)
  proj.broadcast({
    type: 'session-archived',
    data: {
      sessionId: record.sessionId,
      startTime: record.startTime,
      endTime: record.endTime,
      duration: record.duration,
      agentCount: record.metrics.agentCount,
      totalErrors: record.metrics.totalErrors,
      totalTokens: record.metrics.totalTokens,
      skillCount: record.metrics.skillCount,
    },
  });
}

async function handleSessionStart(body) {
  const cwd = body.cwd;
  if (!cwd) return null;

  const normalized = normalizeCwd(cwd);
  const isWorktree = !!resolveWorktreeParentCwd(normalized);

  const proj = await getOrCreateProject(cwd);
  if (!proj) return null;

  // Worktree subagent: just map its session_id, don't archive/reset parent session
  if (isWorktree) {
    if (body.session_id) sessionToProject.set(body.session_id, proj.cwd);
    proj.lastSeen = Date.now();
    return proj;
  }

  // Archive previous session if one exists
  archiveCurrentSession(proj);

  // Map session to project
  if (body.session_id) {
    sessionToProject.set(body.session_id, proj.cwd);
  }

  // Reset session state
  proj.sessionState.sessionId = body.session_id || null;
  proj.sessionState.startTime = Date.now();
  proj.sessionState.totalTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  proj.sessionState.totalErrors = 0;
  proj.sessionState.agentCount = 0;
  proj.sessionState.skillCount = 0;
  proj.sessionState.uniqueSkills = [];

  // Reset all agents
  for (const [key, agent] of proj.agents) {
    agent.status = 'idle';
    agent.activity = '';
    agent.skills = [];
    agent.tools = [];
    agent.toolCount = 0;
    agent.errors = 0;
    agent.lastError = null;
    agent.tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    proj.broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
  }
  proj.activeAgentIds.clear();
  proj.broadcast({ type: 'session-update', data: { ...proj.sessionState } });
  proj.pushLog('system', 'Session started', 'session');
  // Notify UI of project list change (new project or updated lastSeen)
  broadcastGlobal({ type: 'projects-update', data: getProjectsList() });
  return proj;
}

function handleSessionEnd(proj, body) {
  // Worktree subagent ended: just clean up session mapping, don't archive parent
  const normalized = normalizeCwd(body.cwd || '');
  if (resolveWorktreeParentCwd(normalized)) {
    if (body.session_id) sessionToProject.delete(body.session_id);
    return;
  }

  // Archive session before logging end message
  archiveCurrentSession(proj);

  const totalIn = proj.sessionState.totalTokens.input + proj.sessionState.totalTokens.cacheCreation + proj.sessionState.totalTokens.cacheRead;
  const totalOut = proj.sessionState.totalTokens.output;
  proj.pushLog('system', `Session ended — ${proj.sessionState.agentCount} agents, ${formatTokenCount(totalIn)} in / ${formatTokenCount(totalOut)} out, ${proj.sessionState.totalErrors} errors`, 'session');
  for (const [key, agent] of proj.agents) {
    if (agent.status === 'working') {
      agent.status = 'completed';
      agent.activity = 'Session ended';
      proj.broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
    }
  }
  // Clear session ID so it's not reported as "active" after ending
  proj.sessionState.sessionId = null;
  proj.broadcast({ type: 'session-update', data: { ...proj.sessionState } });
  // Flush metrics and suggestions on session end
  proj.saveMetricsDebounced();
  proj.saveSuggestionsDebounced();
}

// --- Stale Agent Cleanup (all projects) ---

setInterval(() => {
  for (const [, proj] of projects) {
    proj.checkStaleAgents();
  }
}, 5_000);

// --- WebSocket ---

function wsAcceptKey(clientKey) {
  return createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

function encodeWSFrame(data) {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWSFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + payloadLen) return null;
  let payload = buffer.slice(offset, offset + payloadLen);
  if (masked && maskKey) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }
  return { opcode, payload, totalLength: offset + payloadLen };
}

function broadcastGlobal(msg) {
  const frame = encodeWSFrame(JSON.stringify(msg));
  for (const socket of wsClients) {
    try { socket.write(frame); } catch { wsClients.delete(socket); }
  }
}

function handleWSConnection(socket) {
  wsClients.add(socket);
  // Send full multi-project state on connect
  const projectsData = [];
  for (const [cwd, proj] of projects) {
    projectsData.push({ id: cwd, name: proj.name, cwd, ...proj.fullState() });
  }
  const stateFrame = encodeWSFrame(JSON.stringify({
    type: 'full-state-multi',
    projects: projectsData,
    projectsList: getProjectsList(),
  }));
  try { socket.write(stateFrame); } catch { /* noop */ }

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length > 0) {
      const frame = decodeWSFrame(buf);
      if (!frame) break;
      buf = buf.slice(frame.totalLength);
      if (frame.opcode === 0x08) {
        const closeFrame = Buffer.alloc(2);
        closeFrame[0] = 0x88;
        closeFrame[1] = 0;
        try { socket.write(closeFrame); } catch { /* noop */ }
        socket.end();
        wsClients.delete(socket);
        return;
      }
      if (frame.opcode === 0x09) {
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0;
        try { socket.write(pong); } catch { /* noop */ }
      }
    }
  });

  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
}

// --- HTTP Server ---

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { resolve('{}'); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', () => resolve('{}'));
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function getProjectFromRequest(url) {
  const projectParam = url.searchParams.get('project');
  if (projectParam) {
    const normalized = normalizeCwd(projectParam);
    return projects.get(normalized) || null;
  }
  // Fallback: if only one project, use it
  if (projects.size === 1) {
    return projects.values().next().value;
  }
  return null;
}

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Serve dashboard HTML
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    try {
      const html = await readFile(join(__dirname, '..', 'ui', 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Could not load dashboard.html');
    }
    return;
  }

  // API: list projects
  if (req.method === 'GET' && path === '/api/projects') {
    sendJSON(res, 200, getProjectsList());
    return;
  }

  // API: delete a project
  if (req.method === 'DELETE' && path === '/api/projects') {
    const raw = await readBody(req);
    let body; try { body = JSON.parse(raw); } catch { body = {}; }
    const id = body && body.id;
    if (!id || !projects.has(id)) { sendJSON(res, 404, { error: 'Project not found' }); return; }
    projects.delete(id);
    for (const [sid, pCwd] of sessionToProject) {
      if (pCwd === id) sessionToProject.delete(sid);
    }
    await saveProjectsRegistry();
    broadcastGlobal({ type: 'projects-update', data: getProjectsList() });
    sendJSON(res, 200, { ok: true });
    return;
  }

  // API: full state (project-scoped)
  if (req.method === 'GET' && path === '/api/state') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 200, { agents: {}, activityLog: [], session: {}, suggestions: [] }); return; }
    sendJSON(res, 200, proj.fullState());
    return;
  }

  // API: session state
  if (req.method === 'GET' && path === '/api/session') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 200, {}); return; }
    sendJSON(res, 200, { ...proj.sessionState });
    return;
  }

  // API: list all sessions (archived + active)
  if (req.method === 'GET' && path === '/api/sessions') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 200, []); return; }

    const list = proj.sessionHistory.map(s => ({
      sessionId: s.sessionId,
      startTime: s.startTime,
      endTime: s.endTime,
      duration: s.duration,
      status: s.status,
      agentCount: s.metrics?.agentCount || 0,
      totalErrors: s.metrics?.totalErrors || 0,
      totalTokens: s.metrics?.totalTokens || { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      skillCount: s.metrics?.skillCount || 0,
    }));

    // Append current active session
    if (proj.sessionState.sessionId) {
      list.push({
        sessionId: proj.sessionState.sessionId,
        startTime: proj.sessionState.startTime,
        endTime: null,
        duration: proj.sessionState.startTime ? Date.now() - proj.sessionState.startTime : null,
        status: 'active',
        agentCount: proj.sessionState.agentCount,
        totalErrors: proj.sessionState.totalErrors,
        totalTokens: { ...proj.sessionState.totalTokens },
        skillCount: proj.sessionState.skillCount,
      });
    }

    list.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    sendJSON(res, 200, list);
    return;
  }

  // API: session detail by ID
  const sessionDetailMatch = path.match(/^\/api\/sessions\/(.+)$/);
  if (req.method === 'GET' && sessionDetailMatch) {
    const proj = getProjectFromRequest(url);
    const sid = decodeURIComponent(sessionDetailMatch[1]);
    if (!proj) { sendJSON(res, 404, { error: 'Project not found' }); return; }

    // Check active session
    if (proj.sessionState.sessionId === sid) {
      const agents = {};
      for (const [key, val] of proj.agents) agents[key] = { ...val, tokens: { ...val.tokens } };
      sendJSON(res, 200, {
        sessionId: sid,
        startTime: proj.sessionState.startTime,
        endTime: null,
        duration: proj.sessionState.startTime ? Date.now() - proj.sessionState.startTime : null,
        status: 'active',
        agents,
        activityLog: proj.activityLog.slice(),
        metrics: {
          totalTokens: { ...proj.sessionState.totalTokens },
          totalErrors: proj.sessionState.totalErrors,
          agentCount: proj.sessionState.agentCount,
          skillCount: proj.sessionState.skillCount,
          uniqueSkills: [...proj.sessionState.uniqueSkills],
          agentBreakdown: {},
        },
      });
      return;
    }

    // Search archived sessions
    const record = proj.sessionHistory.find(s => s.sessionId === sid);
    if (!record) { sendJSON(res, 404, { error: 'Session not found' }); return; }
    sendJSON(res, 200, record);
    return;
  }

  // Advisor API: metrics
  if (req.method === 'GET' && path === '/api/advisor/metrics') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 200, { version: 1, agentTypes: {}, orchestratorStats: {} }); return; }

    const sessionFilter = url.searchParams.get('session');
    if (sessionFilter) {
      // Build filtered metrics
      const filtered = { version: proj.metrics.version, lastUpdated: proj.metrics.lastUpdated, agentTypes: {}, orchestratorStats: proj.metrics.orchestratorStats };
      for (const [agentType, data] of Object.entries(proj.metrics.agentTypes)) {
        const matchingRuns = (data.runs || []).filter(r => r.sessionId === sessionFilter);
        if (matchingRuns.length === 0) continue;
        filtered.agentTypes[agentType] = {
          totalRuns: matchingRuns.length,
          totalToolCalls: matchingRuns.reduce((s, r) => s + (r.toolCount || 0), 0),
          totalErrors: matchingRuns.reduce((s, r) => s + (r.errors || 0), 0),
          totalTokens: matchingRuns.reduce((s, r) => ({
            input: s.input + (r.tokens?.input || 0),
            output: s.output + (r.tokens?.output || 0),
            cacheCreation: s.cacheCreation + (r.tokens?.cacheCreation || 0),
            cacheRead: s.cacheRead + (r.tokens?.cacheRead || 0),
          }), { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }),
          toolFrequency: {},
          runs: matchingRuns,
        };
        for (const run of matchingRuns) {
          for (const tool of (run.tools || [])) {
            filtered.agentTypes[agentType].toolFrequency[tool] = (filtered.agentTypes[agentType].toolFrequency[tool] || 0) + 1;
          }
        }
      }
      sendJSON(res, 200, filtered);
      return;
    }

    sendJSON(res, 200, proj.metrics);
    return;
  }

  // Advisor API: get suggestions
  if (req.method === 'GET' && path === '/api/advisor/suggestions') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 200, []); return; }
    sendJSON(res, 200, [...proj.suggestions.values()]);
    return;
  }

  // Advisor API: post suggestions
  if (req.method === 'POST' && path === '/api/advisor/suggestions') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 400, { error: 'No project specified' }); return; }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const items = Array.isArray(body) ? body : [body];
    const added = [];
    for (const item of items) {
      if (!item.type || !item.title || !item.proposedFile?.content || !item.proposedFile?.path) continue;
      if (!ProjectState.VALID_SUGGESTION_TYPES.has(item.type)) continue;
      const id = item.id || `suggest_${Date.now()}_${randomBytes(3).toString('hex')}`;
      const suggestion = {
        id,
        type: item.type,
        agentType: item.agentType || 'unknown',
        title: item.title,
        summary: item.summary || '',
        reasoning: item.reasoning || '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        proposedFile: item.proposedFile,
        existingFile: item.existingFile || null,
      };
      proj.suggestions.set(id, suggestion);
      added.push(suggestion);
    }
    proj.saveSuggestionsDebounced();
    proj.broadcast({ type: 'advisor-suggestions', data: added });
    proj.pushLog('advisor', `${added.length} new suggestion${added.length !== 1 ? 's' : ''} available`, 'notification');
    sendJSON(res, 200, { ok: true, count: added.length, ids: added.map(s => s.id) });
    return;
  }

  // Advisor API: approve suggestion
  if (req.method === 'POST' && path === '/api/advisor/approve') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 400, { error: 'No project specified' }); return; }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const suggestion = proj.suggestions.get(body.id);
    if (!suggestion) { sendJSON(res, 404, { error: 'Suggestion not found' }); return; }
    if (suggestion.status !== 'pending') { sendJSON(res, 400, { error: `Suggestion already ${suggestion.status}` }); return; }
    if (suggestion.existingFile) {
      try {
        const nativeCwd = proj.cwd.replace(/\//g, (process.platform === 'win32' ? '\\' : '/'));
        const currentContent = await readFile(resolve(nativeCwd, suggestion.existingFile.path), 'utf8');
        if (currentContent !== suggestion.existingFile.content) {
          sendJSON(res, 409, { error: 'File has been modified since this suggestion was generated. Review the changes and regenerate suggestions.' });
          return;
        }
      } catch { /* file doesn't exist yet — ok for new agents */ }
    }
    try {
      const writtenPath = await proj.writeSuggestionFile(suggestion);
      suggestion.status = 'approved';
      proj.saveSuggestionsDebounced();
      proj.broadcast({ type: 'advisor-update', data: { ...suggestion } });
      proj.pushLog('advisor', `Approved: ${suggestion.title}`, 'session');
      sendJSON(res, 200, { ok: true, writtenPath });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Advisor API: dismiss suggestion
  if (req.method === 'POST' && path === '/api/advisor/dismiss') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 400, { error: 'No project specified' }); return; }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const suggestion = proj.suggestions.get(body.id);
    if (!suggestion) { sendJSON(res, 404, { error: 'Suggestion not found' }); return; }
    suggestion.status = 'dismissed';
    proj.saveSuggestionsDebounced();
    proj.broadcast({ type: 'advisor-update', data: { ...suggestion } });
    proj.pushLog('advisor', `Dismissed: ${suggestion.title}`);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // Advisor API: clear suggestion (remove approved/dismissed)
  if (req.method === 'POST' && path === '/api/advisor/clear') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 400, { error: 'No project specified' }); return; }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const suggestion = proj.suggestions.get(body.id);
    if (!suggestion) { sendJSON(res, 404, { error: 'Suggestion not found' }); return; }
    if (suggestion.status === 'pending') { sendJSON(res, 400, { error: 'Cannot clear a pending suggestion' }); return; }
    proj.suggestions.delete(body.id);
    proj.saveSuggestionsDebounced();
    proj.broadcast({ type: 'advisor-cleared', data: { id: body.id } });
    sendJSON(res, 200, { ok: true });
    return;
  }

  // Agent CRUD endpoints (project-scoped)
  const agentMatch = path.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/);

  if (req.method === 'GET' && path === '/api/agents') {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 200, []); return; }
    const defs = await proj.listAgentDefinitions();
    for (const def of defs) {
      def.metrics = proj.metrics.agentTypes[def.name] || null;
    }
    sendJSON(res, 200, defs);
    return;
  }

  if (req.method === 'GET' && agentMatch) {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 400, { error: 'No project specified' }); return; }
    const name = agentMatch[1];
    const filePath = join(proj.agentsDir, `${name}.md`);
    if (!proj.validateAgentPath(filePath)) { sendJSON(res, 400, { error: 'Invalid agent name' }); return; }
    try {
      const content = await readFile(filePath, 'utf8');
      const parsed = parseAgentFile(content);
      let liveStatus = 'idle';
      let liveData = null;
      for (const [, agent] of proj.agents) {
        if (agent.agentType === name && agent.status !== 'idle') {
          liveStatus = agent.status;
          liveData = { ...agent };
          break;
        }
      }
      sendJSON(res, 200, {
        name: parsed.frontmatter.name || name,
        description: parsed.frontmatter.description || '',
        tools: parsed.frontmatter.tools || [],
        model: parsed.frontmatter.model || '',
        body: parsed.body,
        liveStatus,
        liveData,
        metrics: proj.metrics.agentTypes[name] || null,
      });
    } catch {
      sendJSON(res, 404, { error: 'Agent not found' });
    }
    return;
  }

  if (req.method === 'PUT' && agentMatch) {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 400, { error: 'No project specified' }); return; }
    const name = agentMatch[1];
    if (!/^[a-z0-9_-]+$/.test(name)) { sendJSON(res, 400, { error: 'Invalid agent name: use lowercase letters, digits, hyphens, underscores' }); return; }
    const filePath = join(proj.agentsDir, `${name}.md`);
    if (!proj.validateAgentPath(filePath)) { sendJSON(res, 400, { error: 'Invalid path' }); return; }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const content = buildAgentFileContent({ name, description: body.description, tools: body.tools, model: body.model, body: body.body });
    await mkdir(proj.agentsDir, { recursive: true });
    const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
    await writeFile(tmpPath, content);
    await rename(tmpPath, filePath);
    proj.broadcast({ type: 'agent-definition-changed', name });
    sendJSON(res, 200, { ok: true, name });
    return;
  }

  if (req.method === 'DELETE' && agentMatch) {
    const proj = getProjectFromRequest(url);
    if (!proj) { sendJSON(res, 400, { error: 'No project specified' }); return; }
    const name = agentMatch[1];
    const filePath = join(proj.agentsDir, `${name}.md`);
    if (!proj.validateAgentPath(filePath)) { sendJSON(res, 400, { error: 'Invalid path' }); return; }
    try {
      await unlink(filePath);
      proj.broadcast({ type: 'agent-definition-changed', name });
      sendJSON(res, 200, { ok: true, deleted: name });
    } catch {
      sendJSON(res, 404, { error: 'Agent not found' });
    }
    return;
  }

  // Hook endpoints
  if (req.method === 'POST' && path.startsWith('/hooks/')) {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }

    const hook = path.slice(7); // strip "/hooks/"

    // session-start is special: it creates/resolves the project
    if (hook === 'session-start') {
      await handleSessionStart(body);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // register-project: lightweight pre-registration from command hook using $CLAUDE_PROJECT_DIR.
    // Called before the HTTP session-start hook so the project exists even if the HTTP body
    // omits cwd, and so subsequent SubagentStart hooks can be attributed to the right project.
    if (hook === 'register-project') {
      if (body.cwd) {
        const proj = await getOrCreateProject(body.cwd);
        if (proj && body.session_id) sessionToProject.set(body.session_id, proj.cwd);
      }
      sendJSON(res, 200, { ok: true });
      return;
    }

    // All other hooks: resolve project from session_id or body
    const proj = resolveProject(body);
    if (!proj) {
      // If we can't resolve, try cwd from body to auto-create
      if (body.cwd) {
        const newProj = await getOrCreateProject(body.cwd);
        if (body.session_id && newProj) sessionToProject.set(body.session_id, newProj.cwd);
        if (newProj) {
          switch (hook) {
            case 'subagent-start':       handleSubagentStart(newProj, body); break;
            case 'subagent-stop':        await handleSubagentStop(newProj, body); break;
            case 'pre-tool-use':         handlePreToolUse(newProj, body); break;
            case 'post-tool-use':        handlePostToolUse(newProj, body); break;
            case 'post-tool-use-failure': handlePostToolUseFailure(newProj, body); break;
            case 'stop':                 handleStop(newProj, body); break;
            case 'notification':         handleNotification(newProj, body); break;
            case 'session-end':          handleSessionEnd(newProj, body); break;
          }
        }
      }
      sendJSON(res, 200, { ok: true });
      return;
    }

    switch (hook) {
      case 'subagent-start':       handleSubagentStart(proj, body); break;
      case 'subagent-stop':        await handleSubagentStop(proj, body); break;
      case 'pre-tool-use':         handlePreToolUse(proj, body); break;
      case 'post-tool-use':        handlePostToolUse(proj, body); break;
      case 'post-tool-use-failure': handlePostToolUseFailure(proj, body); break;
      case 'stop':                 handleStop(proj, body); break;
      case 'notification':         handleNotification(proj, body); break;
      case 'session-end':          handleSessionEnd(proj, body); break;
    }

    sendJSON(res, 200, { ok: true });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = wsAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  handleWSConnection(socket);
});

// Load persisted data then start
(async () => {
  await ensurePluginAdvisorDir();
  await loadProjectsRegistry();
  // Load metrics and suggestions for all known projects
  for (const [, proj] of projects) {
    await proj.loadMetrics();
    await proj.loadSuggestions();
    await proj.loadSessions();
  }
  server.listen(PORT, () => {
    console.log(`Agent Dashboard server running on http://localhost:${PORT}`);
    console.log(`Loaded ${projects.size} project(s) from registry`);
    console.log('Waiting for Claude Code hook events...');
  });
})();
