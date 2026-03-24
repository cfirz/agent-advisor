#!/usr/bin/env node
// Agent Dashboard Server — zero dependencies, Node.js built-in only
// Receives Claude Code hook events via HTTP POST, serves dashboard UI,
// and pushes real-time updates to browsers via WebSocket.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8099', 10);
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB9A3F8D85E';

// --- State ---

const ORCHESTRATOR = 'orchestrator';
const agents = new Map(); // agent_type -> { status, activity, lastSeen, toolCount, agentId }
const activityLog = [];   // circular buffer, max 100
const MAX_LOG = 100;
const wsClients = new Set();

function getAgentState(agentType) {
  if (!agents.has(agentType)) {
    agents.set(agentType, {
      status: 'idle',
      activity: '',
      lastSeen: null,
      toolCount: 0,
      agentId: null,
      stale: false,
      skills: [],
      tools: [],
    });
  }
  return agents.get(agentType);
}

function fullState() {
  const obj = {};
  for (const [key, val] of agents) obj[key] = { ...val };
  return { agents: obj, activityLog: activityLog.slice() };
}

function pushLog(agentType, message) {
  const entry = { time: Date.now(), agent: agentType, message };
  activityLog.push(entry);
  if (activityLog.length > MAX_LOG) activityLog.shift();
  broadcast({ type: 'activity', data: entry });
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

// --- Hook Handlers ---

function handleSubagentStart(body) {
  const agentType = body.agent_type;
  if (!agentType) return;
  const agent = getAgentState(agentType);
  agent.status = 'working';
  agent.activity = 'Starting up...';
  agent.lastSeen = Date.now();
  agent.toolCount = 0;
  agent.agentId = body.agent_id || null;
  agent.stale = false;
  agent.skills = [];
  agent.tools = [];
  broadcast({ type: 'agent-update', agent: agentType, data: { ...agent } });
  pushLog(agentType, 'Started');
}

function handleSubagentStop(body) {
  const agentType = body.agent_type;
  if (!agentType) return;
  const agent = getAgentState(agentType);
  agent.status = 'completed';
  agent.activity = 'Finished';
  agent.lastSeen = Date.now();
  broadcast({ type: 'agent-update', agent: agentType, data: { ...agent } });
  const skillsSuffix = agent.skills.length ? `, skills: ${agent.skills.join(', ')}` : '';
  pushLog(agentType, `Completed (${agent.toolCount} tools used${skillsSuffix})`);
  // Auto-transition to idle after 30s
  setTimeout(() => {
    if (agent.status === 'completed') {
      agent.status = 'idle';
      agent.activity = '';
      agent.skills = [];
      agent.tools = [];
      broadcast({ type: 'agent-update', agent: agentType, data: { ...agent } });
    }
  }, 30_000);
}

function handlePreToolUse(body) {
  const agentType = body.agent_type || ORCHESTRATOR;
  const agent = getAgentState(agentType);
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
  broadcast({ type: 'agent-update', agent: agentType, data: { ...agent } });
  pushLog(agentType, activity);
}

function handlePostToolUse(body) {
  const agentType = body.agent_type || ORCHESTRATOR;
  const agent = agents.get(agentType);
  if (agent) {
    agent.lastSeen = Date.now();
  }
}

// --- Stale Agent Cleanup ---
// 30s no events → "stale" (amber warning), 90s → auto-idle

setInterval(() => {
  const now = Date.now();
  for (const [agentType, agent] of agents) {
    if (agent.status === 'working' && agent.lastSeen) {
      const age = now - agent.lastSeen;
      if (age > 90_000) {
        // 90s with no events → assume agent is gone
        agent.status = 'idle';
        agent.activity = '';
        agent.skills = [];
        agent.tools = [];
        broadcast({ type: 'agent-update', agent: agentType, data: { ...agent } });
        pushLog(agentType, 'No events for 90s — marked idle');
      } else if (age > 30_000 && !agent.stale) {
        // 30s with no events → mark as stale (visual warning)
        agent.stale = true;
        broadcast({ type: 'agent-update', agent: agentType, data: { ...agent } });
      }
    }
  }
}, 5_000); // check every 5s for responsiveness

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
        // Close frame
        const closeFrame = Buffer.alloc(2);
        closeFrame[0] = 0x88;
        closeFrame[1] = 0;
        try { socket.write(closeFrame); } catch { /* noop */ }
        socket.end();
        wsClients.delete(socket);
        return;
      }
      if (frame.opcode === 0x09) {
        // Ping -> Pong
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

  // Hook endpoints
  if (req.method === 'POST' && path.startsWith('/hooks/')) {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }

    const hook = path.slice(7); // strip "/hooks/"
    switch (hook) {
      case 'subagent-start': handleSubagentStart(body); break;
      case 'subagent-stop': handleSubagentStop(body); break;
      case 'pre-tool-use': handlePreToolUse(body); break;
      case 'post-tool-use': handlePostToolUse(body); break;
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

server.listen(PORT, () => {
  console.log(`Agent Dashboard server running on http://localhost:${PORT}`);
  console.log('Waiting for Claude Code hook events...');
});
