#!/usr/bin/env node
// Agent Dashboard Server — zero dependencies, Node.js built-in only
// Receives Claude Code hook events via HTTP POST, serves dashboard UI,
// and pushes real-time updates to browsers via WebSocket.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { join, dirname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8099', 10);
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB9A3F8D85E';
const PROJECT_ROOT = resolve(__dirname, '..');
const ADVISOR_DIR = join(PROJECT_ROOT, '.claude', 'advisor-data');
const METRICS_PATH = join(ADVISOR_DIR, 'metrics.json');
const SUGGESTIONS_PATH = join(ADVISOR_DIR, 'suggestions.json');
const AGENTS_DIR = join(PROJECT_ROOT, '.claude', 'agents');

// --- State ---

const ORCHESTRATOR = 'orchestrator';
const agents = new Map(); // agentKey -> { agentType, status, activity, lastSeen, toolCount, agentId, ... }
const activityLog = [];   // circular buffer, max 100
const MAX_LOG = 100;
const wsClients = new Set();

// Maps agent_type -> most recent agent_id (for PreToolUse/PostToolUse which don't always have agent_id)
const activeAgentIds = new Map();

// --- Advisor: Metrics & Suggestions ---

const MAX_RUNS_PER_AGENT = 20;
let metrics = { version: 1, lastUpdated: null, agentTypes: {}, orchestratorStats: { totalTurns: 0, toolFrequency: {}, agentTypesSpawned: [] } };
const suggestions = new Map(); // id -> suggestion object
let metricsSaveTimer = null;
let suggestionsSaveTimer = null;
// Track per-agent start times for duration calculation
const agentStartTimes = new Map(); // agentKey -> timestamp

async function ensureAdvisorDir() {
  if (!existsSync(ADVISOR_DIR)) await mkdir(ADVISOR_DIR, { recursive: true });
}

async function loadMetrics() {
  try {
    const raw = await readFile(METRICS_PATH, 'utf8');
    metrics = JSON.parse(raw);
  } catch { /* file missing or corrupt — use defaults */ }
}

function saveMetricsDebounced() {
  if (metricsSaveTimer) clearTimeout(metricsSaveTimer);
  metricsSaveTimer = setTimeout(async () => {
    try {
      await ensureAdvisorDir();
      metrics.lastUpdated = new Date().toISOString();
      await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2));
    } catch (e) { console.error('Failed to save metrics:', e.message); }
  }, 500);
}

async function loadSuggestions() {
  try {
    const raw = await readFile(SUGGESTIONS_PATH, 'utf8');
    const arr = JSON.parse(raw);
    for (const s of arr) suggestions.set(s.id, s);
  } catch { /* file missing or corrupt */ }
}

function saveSuggestionsDebounced() {
  if (suggestionsSaveTimer) clearTimeout(suggestionsSaveTimer);
  suggestionsSaveTimer = setTimeout(async () => {
    try {
      await ensureAdvisorDir();
      const arr = [...suggestions.values()];
      await writeFile(SUGGESTIONS_PATH, JSON.stringify(arr, null, 2));
    } catch (e) { console.error('Failed to save suggestions:', e.message); }
  }, 500);
}

function recordAgentRun(agentType, agentData, durationMs) {
  if (!metrics.agentTypes[agentType]) {
    metrics.agentTypes[agentType] = {
      totalRuns: 0, totalToolCalls: 0, totalErrors: 0,
      totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      toolFrequency: {}, runs: [],
    };
  }
  const m = metrics.agentTypes[agentType];
  m.totalRuns++;
  m.totalToolCalls += agentData.toolCount || 0;
  m.totalErrors += agentData.errors || 0;
  const t = agentData.tokens || {};
  m.totalTokens.input += t.input || 0;
  m.totalTokens.output += t.output || 0;
  m.totalTokens.cacheCreation += t.cacheCreation || 0;
  m.totalTokens.cacheRead += t.cacheRead || 0;
  // Tool frequency
  for (const tool of (agentData.tools || [])) {
    m.toolFrequency[tool] = (m.toolFrequency[tool] || 0) + 1;
  }
  // Run record
  m.runs.push({
    timestamp: new Date().toISOString(),
    toolCount: agentData.toolCount || 0,
    errors: agentData.errors || 0,
    tokens: { ...t },
    tools: [...(agentData.tools || [])],
    skills: [...(agentData.skills || [])],
    durationMs: durationMs || 0,
  });
  if (m.runs.length > MAX_RUNS_PER_AGENT) m.runs.shift();
  // Track in orchestrator stats
  const os = metrics.orchestratorStats;
  if (!os.agentTypesSpawned.includes(agentType)) {
    os.agentTypesSpawned.push(agentType);
  }
  saveMetricsDebounced();
}

function trackOrchestratorTool(toolName) {
  const os = metrics.orchestratorStats;
  os.toolFrequency[toolName] = (os.toolFrequency[toolName] || 0) + 1;
}

function validateAgentPath(filePath) {
  const resolved = resolve(PROJECT_ROOT, filePath);
  const normalizedAgentsDir = normalize(AGENTS_DIR);
  return resolved.startsWith(normalizedAgentsDir) && resolved.endsWith('.md');
}

async function writeAgentFile(suggestion) {
  const filePath = suggestion.proposedFile?.path;
  if (!filePath) throw new Error('No file path in suggestion');
  if (!validateAgentPath(filePath)) throw new Error('Invalid path: must be within .claude/agents/ and end with .md');
  const fullPath = resolve(PROJECT_ROOT, filePath);
  await mkdir(dirname(fullPath), { recursive: true });
  // Atomic write: write to tmp then rename
  const tmpPath = fullPath + '.tmp.' + randomBytes(4).toString('hex');
  await writeFile(tmpPath, suggestion.proposedFile.content);
  await rename(tmpPath, fullPath);
  return fullPath;
}

const sessionState = {
  sessionId: null,
  startTime: null,
  totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
  totalErrors: 0,
  agentCount: 0,
};

// Each agent instance gets a unique key based on agent_id.
// The orchestrator always uses the key "orchestrator".
function agentKey(agentType, agentId) {
  if (agentType === ORCHESTRATOR || !agentId) return agentType || ORCHESTRATOR;
  return `${agentType}::${agentId}`;
}

function getAgentState(key, agentType) {
  if (!agents.has(key)) {
    agents.set(key, {
      agentType: agentType || key, // display name
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
  return agents.get(key);
}

function fullState() {
  const obj = {};
  for (const [key, val] of agents) obj[key] = { ...val };
  const sugg = [...suggestions.values()];
  return { agents: obj, activityLog: activityLog.slice(), session: { ...sessionState }, suggestions: sugg };
}

function pushLog(displayName, message, level = 'info') {
  const entry = { time: Date.now(), agent: displayName, message, level };
  activityLog.push(entry);
  if (activityLog.length > MAX_LOG) activityLog.shift();
  broadcast({ type: 'activity', data: entry });
}

// Resolve the agent key for tool-use events.
// These events have agent_type but may not have agent_id.
// Use the activeAgentIds map to find the current instance.
function resolveToolAgentKey(body) {
  const agentType = body.agent_type || ORCHESTRATOR;
  const agentId = body.agent_id || activeAgentIds.get(agentType) || null;
  return { key: agentKey(agentType, agentId), agentType };
}

// --- Activity Description Parser ---

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

// --- Token Parsing ---

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

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
  // Project slug is derived from cwd: replace path separators with dashes
  const cwdNorm = (cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
  const slug = cwdNorm.replace(/[/:]/g, '-').replace(/^-+/, '');
  return join(homedir(), '.claude', 'projects', slug, sessionId, 'subagents', `agent-a${agentId}.jsonl`);
}

// --- Hook Handlers ---

function handleSubagentStart(body) {
  const agentType = body.agent_type;
  if (!agentType) return;
  const agentId = body.agent_id || null;
  const key = agentKey(agentType, agentId);

  // Track the active agent_id for this agent_type (for tool events that lack agent_id)
  if (agentId) activeAgentIds.set(agentType, agentId);

  const agent = getAgentState(key, agentType);
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

  if (body.session_id && !sessionState.sessionId) {
    sessionState.sessionId = body.session_id;
  }
  sessionState.agentCount++;

  broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
  broadcast({ type: 'session-update', data: { ...sessionState } });

  // Track start time for duration calculation
  agentStartTimes.set(key, Date.now());

  // Include short agent_id in log for disambiguation
  const idSuffix = agentId ? ` (${agentId.slice(-6)})` : '';
  pushLog(agentType, `Started${idSuffix}`);
}

async function handleSubagentStop(body) {
  const agentType = body.agent_type;
  if (!agentType) return;
  const agentId = body.agent_id || activeAgentIds.get(agentType) || null;
  const key = agentKey(agentType, agentId);
  const agent = getAgentState(key, agentType);
  agent.status = 'completed';
  agent.activity = 'Finished';
  agent.lastSeen = Date.now();

  // Parse transcript for token usage
  let transcriptPath = body.agent_transcript_path || null;
  if (!transcriptPath) {
    transcriptPath = buildTranscriptPath(sessionState.sessionId || body.session_id, agent.agentId, body.cwd);
  }
  if (transcriptPath) {
    const tokens = await parseTranscriptTokens(transcriptPath);
    agent.tokens = tokens;
    const totalIn = tokens.input + tokens.cacheCreation + tokens.cacheRead;
    const totalOut = tokens.output;
    sessionState.totalTokens.input += tokens.input;
    sessionState.totalTokens.output += tokens.output;
    sessionState.totalTokens.cacheCreation += tokens.cacheCreation;
    sessionState.totalTokens.cacheRead += tokens.cacheRead;
    broadcast({ type: 'session-update', data: { ...sessionState } });
    if (totalIn > 0 || totalOut > 0) {
      pushLog(agentType, `Tokens: ${formatTokenCount(totalIn)} in / ${formatTokenCount(totalOut)} out`);
    }
  }

  broadcast({ type: 'agent-update', agent: key, data: { ...agent } });

  // Record metrics for advisor
  const startTime = agentStartTimes.get(key);
  const durationMs = startTime ? Date.now() - startTime : 0;
  agentStartTimes.delete(key);
  recordAgentRun(agentType, agent, durationMs);

  const skillsSuffix = agent.skills.length ? `, skills: ${agent.skills.join(', ')}` : '';
  const idSuffix = agent.agentId ? ` (${agent.agentId.slice(-6)})` : '';
  pushLog(agentType, `Completed${idSuffix} (${agent.toolCount} tools used${skillsSuffix})`);

  // Clear the activeAgentIds mapping if this was the active one
  if (agentId && activeAgentIds.get(agentType) === agentId) {
    activeAgentIds.delete(agentType);
  }

  // Auto-transition to idle after 30s
  const capturedKey = key;
  setTimeout(() => {
    if (agent.status === 'completed') {
      agent.status = 'idle';
      agent.activity = '';
      agent.skills = [];
      agent.tools = [];
      broadcast({ type: 'agent-update', agent: capturedKey, data: { ...agent } });
    }
  }, 30_000);
}

function handlePreToolUse(body) {
  const { key, agentType } = resolveToolAgentKey(body);
  const agent = getAgentState(key, agentType);
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
  } else if (toolName && !agent.tools.includes(toolName)) {
    agent.tools.push(toolName);
  }
  agent.stale = false;
  if (agent.status !== 'working') agent.status = 'working';
  broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
  pushLog(agentType, activity);
  // Track orchestrator-level tool frequency for advisor
  if (toolName) trackOrchestratorTool(toolName);
}

function handlePostToolUse(body) {
  const { key } = resolveToolAgentKey(body);
  const agent = agents.get(key);
  if (agent) {
    agent.lastSeen = Date.now();
  }
}

function handlePostToolUseFailure(body) {
  const { key, agentType } = resolveToolAgentKey(body);
  const agent = getAgentState(key, agentType);
  agent.lastSeen = Date.now();
  agent.errors++;
  const toolName = body.tool_name || 'unknown';
  const errorMsg = body.error || body.tool_result || 'Unknown error';
  agent.lastError = { tool: toolName, message: trunc(String(errorMsg), 200), time: Date.now() };
  sessionState.totalErrors++;
  broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
  broadcast({ type: 'session-update', data: { ...sessionState } });
  pushLog(agentType, `FAILED: ${toolName} — ${trunc(String(errorMsg), 100)}`, 'error');
}

function handleStop(body) {
  const agent = getAgentState(ORCHESTRATOR, ORCHESTRATOR);
  agent.status = 'completed';
  agent.activity = 'Turn finished';
  agent.lastSeen = Date.now();
  broadcast({ type: 'agent-update', agent: ORCHESTRATOR, data: { ...agent } });
  const reason = body.stop_reason || body.reason || 'end_turn';
  pushLog(ORCHESTRATOR, `Turn completed (${reason})`);
  metrics.orchestratorStats.totalTurns++;
  saveMetricsDebounced();
  // Auto-transition to idle after 30s
  setTimeout(() => {
    if (agent.status === 'completed') {
      agent.status = 'idle';
      agent.activity = '';
      broadcast({ type: 'agent-update', agent: ORCHESTRATOR, data: { ...agent } });
    }
  }, 30_000);
}

function handleNotification(body) {
  const message = body.message || body.notification || body.title || 'Notification';
  pushLog('system', trunc(String(message), 200), 'notification');
}

function handleSessionStart(body) {
  // Reset session state
  sessionState.sessionId = body.session_id || null;
  sessionState.startTime = Date.now();
  sessionState.totalTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  sessionState.totalErrors = 0;
  sessionState.agentCount = 0;
  // Reset all agents
  for (const [key, agent] of agents) {
    agent.status = 'idle';
    agent.activity = '';
    agent.skills = [];
    agent.tools = [];
    agent.toolCount = 0;
    agent.errors = 0;
    agent.lastError = null;
    agent.tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
  }
  activeAgentIds.clear();
  broadcast({ type: 'session-update', data: { ...sessionState } });
  pushLog('system', 'Session started', 'session');
}

function handleSessionEnd(body) {
  const totalIn = sessionState.totalTokens.input + sessionState.totalTokens.cacheCreation + sessionState.totalTokens.cacheRead;
  const totalOut = sessionState.totalTokens.output;
  pushLog('system', `Session ended — ${sessionState.agentCount} agents, ${formatTokenCount(totalIn)} in / ${formatTokenCount(totalOut)} out, ${sessionState.totalErrors} errors`, 'session');
  // Mark all active agents as completed
  for (const [key, agent] of agents) {
    if (agent.status === 'working') {
      agent.status = 'completed';
      agent.activity = 'Session ended';
      broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
    }
  }
}

// --- Stale Agent Cleanup ---
// 30s no events → "stale" (amber warning), 90s → auto-idle

setInterval(() => {
  const now = Date.now();
  for (const [key, agent] of agents) {
    if (agent.status === 'working' && agent.lastSeen) {
      const age = now - agent.lastSeen;
      if (age > 90_000) {
        agent.status = 'idle';
        agent.activity = '';
        agent.skills = [];
        agent.tools = [];
        broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
        pushLog(agent.agentType || key, 'No events for 90s — marked idle');
      } else if (age > 30_000 && !agent.stale) {
        agent.stale = true;
        broadcast({ type: 'agent-update', agent: key, data: { ...agent } });
      }
    }
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

function broadcast(msg) {
  const frame = encodeWSFrame(JSON.stringify(msg));
  for (const socket of wsClients) {
    try { socket.write(frame); } catch { wsClients.delete(socket); }
  }
}

function handleWSConnection(socket) {
  wsClients.add(socket);
  // Send full state on connect
  const stateFrame = encodeWSFrame(JSON.stringify({ type: 'full-state', data: fullState() }));
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Serve dashboard HTML (always read from disk for dev reload)
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

  // API: full state
  if (req.method === 'GET' && path === '/api/state') {
    sendJSON(res, 200, fullState());
    return;
  }

  // API: session state
  if (req.method === 'GET' && path === '/api/session') {
    sendJSON(res, 200, { ...sessionState });
    return;
  }

  // Advisor API: metrics
  if (req.method === 'GET' && path === '/api/advisor/metrics') {
    sendJSON(res, 200, metrics);
    return;
  }

  // Advisor API: get suggestions
  if (req.method === 'GET' && path === '/api/advisor/suggestions') {
    sendJSON(res, 200, [...suggestions.values()]);
    return;
  }

  // Advisor API: post suggestions (from advisor skill)
  if (req.method === 'POST' && path === '/api/advisor/suggestions') {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const items = Array.isArray(body) ? body : [body];
    const added = [];
    for (const item of items) {
      if (!item.type || !item.title || !item.proposedFile?.content) continue;
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
      suggestions.set(id, suggestion);
      added.push(suggestion);
    }
    saveSuggestionsDebounced();
    broadcast({ type: 'advisor-suggestions', data: added });
    pushLog('advisor', `${added.length} new suggestion${added.length !== 1 ? 's' : ''} available`, 'notification');
    sendJSON(res, 200, { ok: true, count: added.length, ids: added.map(s => s.id) });
    return;
  }

  // Advisor API: approve suggestion
  if (req.method === 'POST' && path === '/api/advisor/approve') {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const suggestion = suggestions.get(body.id);
    if (!suggestion) { sendJSON(res, 404, { error: 'Suggestion not found' }); return; }
    if (suggestion.status !== 'pending') { sendJSON(res, 400, { error: `Suggestion already ${suggestion.status}` }); return; }
    // Conflict detection: check if existing file changed since suggestion was generated
    if (suggestion.existingFile) {
      try {
        const currentContent = await readFile(resolve(PROJECT_ROOT, suggestion.existingFile.path), 'utf8');
        if (currentContent !== suggestion.existingFile.content) {
          sendJSON(res, 409, { error: 'File has been modified since this suggestion was generated. Review the changes and regenerate suggestions.' });
          return;
        }
      } catch { /* file doesn't exist yet — ok for new agents */ }
    }
    try {
      const writtenPath = await writeAgentFile(suggestion);
      suggestion.status = 'approved';
      saveSuggestionsDebounced();
      broadcast({ type: 'advisor-update', data: { ...suggestion } });
      pushLog('advisor', `Approved: ${suggestion.title}`, 'session');
      sendJSON(res, 200, { ok: true, writtenPath });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Advisor API: dismiss suggestion
  if (req.method === 'POST' && path === '/api/advisor/dismiss') {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const suggestion = suggestions.get(body.id);
    if (!suggestion) { sendJSON(res, 404, { error: 'Suggestion not found' }); return; }
    suggestion.status = 'dismissed';
    saveSuggestionsDebounced();
    broadcast({ type: 'advisor-update', data: { ...suggestion } });
    pushLog('advisor', `Dismissed: ${suggestion.title}`);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // Hook endpoints
  if (req.method === 'POST' && path.startsWith('/hooks/')) {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }

    const hook = path.slice(7); // strip "/hooks/"
    switch (hook) {
      case 'subagent-start':       handleSubagentStart(body); break;
      case 'subagent-stop':        await handleSubagentStop(body); break;
      case 'pre-tool-use':         handlePreToolUse(body); break;
      case 'post-tool-use':        handlePostToolUse(body); break;
      case 'post-tool-use-failure': handlePostToolUseFailure(body); break;
      case 'stop':                 handleStop(body); break;
      case 'notification':         handleNotification(body); break;
      case 'session-start':        handleSessionStart(body); break;
      case 'session-end':          handleSessionEnd(body); break;
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
  await loadMetrics();
  await loadSuggestions();
  server.listen(PORT, () => {
    console.log(`Agent Dashboard server running on http://localhost:${PORT}`);
    console.log('Waiting for Claude Code hook events...');
  });
})();
