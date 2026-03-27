const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4200;
const HOST = '127.0.0.1';

// Workspace paths
const WS_PRIME = process.env.WORKSPACE_PRIME || path.join(process.env.HOME, '.openclaw/workspace');
const WS_QYREN = process.env.WORKSPACE_QYREN_COORD || path.join(process.env.HOME, '.openclaw/workspace-qyren-coord');

// All agent workspace paths
const AGENT_WORKSPACES = {
  'prime': WS_PRIME,
  'qyren-coord': WS_QYREN,
  'manzil-coord': path.join(process.env.HOME, '.openclaw/workspace-manzil-coord'),
  'rail-coord': path.join(process.env.HOME, '.openclaw/workspace-rail-coord'),
  'poly-coord': path.join(process.env.HOME, '.openclaw/workspace-poly-coord'),
  'worker-researcher': path.join(process.env.HOME, '.openclaw/workspace-worker-researcher'),
  'worker-writer': path.join(process.env.HOME, '.openclaw/workspace-worker-writer'),
  'worker-coder': path.join(process.env.HOME, '.openclaw/workspace-worker-coder'),
  'worker-qa': path.join(process.env.HOME, '.openclaw/workspace-worker-qa'),
};

// Docs directory map
const DOC_DIRS = {
  blogs: path.join(WS_QYREN, 'drafts/blogs'),
  playbook: path.join(WS_QYREN, 'drafts/playbook'),
  research: path.join(WS_PRIME, 'content/research'),
};

function getTodayDubai() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Dubai' }).split(',')[0].trim();
}

function readFileSimple(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch { return null; }
}

function scanDocDir(dir, type) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = path.join(dir, f);
        const content = readFileSimple(filePath) || '';
        const stat = fs.statSync(filePath);
        return {
          slug: f.replace('.md', ''),
          filename: f,
          type,
          modified: stat.mtime.toISOString(),
          size: stat.size,
          content,
          word_count: content.split(/\s+/).filter(Boolean).length,
        };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
  } catch { return []; }
}

// Auth key — from env or .openclaw/.env file
let EVO_API_KEY = process.env.EVO_API_KEY;
if (!EVO_API_KEY) {
  try {
    const envPath = path.join(process.env.HOME, '.openclaw/.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/EVO_API_KEY=(.+)/);
    if (match) EVO_API_KEY = match[1].trim();
  } catch (e) { /* no env file */ }
}

// In-memory cache for last good parse
const cache = {};

// ═══ Auth middleware ═══
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!EVO_API_KEY) return res.status(500).json({ error: 'EVO_API_KEY not configured' });
  if (!header || header !== `Bearer ${EVO_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ═══ File reader with cache fallback ═══
function readFile(filePath, cacheKey) {
  try {
    if (!fs.existsSync(filePath)) {
      return { content: null, warning: `File not found: ${path.basename(filePath)}` };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    cache[cacheKey] = content;
    return { content };
  } catch (e) {
    if (cache[cacheKey]) {
      return { content: cache[cacheKey], error: 'parse_failed', file: path.basename(filePath) };
    }
    return { content: null, error: e.message };
  }
}

// ═══ Parsers ═══

function parseMissions(content) {
  if (!content) return [];
  const blocks = content.split(/^## /m).slice(1); // skip header
  return blocks.map(block => {
    const lines = block.trim().split('\n');
    // Header line: M-001 | 2026-03-26 | qyren | content_pipeline
    const headerMatch = lines[0].match(/^(M-\d+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)/);
    if (!headerMatch) return null;

    const mission = {
      id: headerMatch[1],
      date: headerMatch[2],
      project: headerMatch[3],
      type: headerMatch[4],
      steps: [],
      remarks: []
    };

    let section = 'fields'; // fields | steps | remarks
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line === '### Steps') { section = 'steps'; continue; }
      if (line === '### Remarks') { section = 'remarks'; continue; }

      if (section === 'fields') {
        const kvMatch = line.match(/^(\w[\w.]*)\s*:\s*(.+)/);
        if (kvMatch) {
          let val = kvMatch[2].trim().replace(/^"(.*)"$/, '$1');
          if (val === 'true') val = true;
          else if (val === 'false') val = false;
          else if (/^\d+$/.test(val)) val = parseInt(val);
          mission[kvMatch[1]] = val;
        }
      } else if (section === 'steps') {
        // - [x] S-1 | worker-researcher | research_brief | done | 2026-03-26 06:47
        const stepMatch = line.match(/^- \[([ xX])\]\s*(S-\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+?)(?:\|\s*(.*))?$/);
        if (stepMatch) {
          mission.steps.push({
            id: stepMatch[2].trim(),
            worker: stepMatch[3].trim(),
            task_type: stepMatch[4].trim(),
            status: stepMatch[5].trim(),
            timestamp: (stepMatch[6] || '').trim()
          });
        }
      } else if (section === 'remarks') {
        mission.remarks.push(line);
      }
    }
    return mission;
  }).filter(Boolean);
}

function parseTasks(content) {
  if (!content) return [];
  const blocks = content.split(/^## /m).slice(1);
  return blocks.map(block => {
    const lines = block.trim().split('\n');
    // Header: T-001 | P1 | content | todo | 2026-03-26
    const headerMatch = lines[0].match(/^(T-\d+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)/);
    if (!headerMatch) return null;

    const task = {
      id: headerMatch[1],
      priority: headerMatch[2],
      category: headerMatch[3],
      status: headerMatch[4],
      date: headerMatch[5],
      text: '',
      ref: null
    };

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const refMatch = line.match(/^ref:\s*(.+)/);
      if (refMatch) {
        task.ref = refMatch[1].trim();
      } else if (!task.text) {
        task.text = line;
      }
    }
    return task;
  }).filter(Boolean);
}

function parseActivity(content, date) {
  if (!content) return [];
  const lines = content.split('\n');
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^(\d{2}:\d{2})\s*\|\s*([^|]+)\|\s*(.+)/);
    if (match) {
      entries.push({
        time: match[1].trim(),
        agent: match[2].trim(),
        summary: match[3].trim(),
        date
      });
    }
  }
  return entries;
}

function parseLeads(content) {
  if (!content) return [];
  const blocks = content.split(/^## /m).slice(1);
  return blocks.map(block => {
    const lines = block.trim().split('\n');
    // Header: L-001 | Hypercasual Labs | researched | 2026-03-26
    const headerMatch = lines[0].match(/^(L-\d+)\s*\|\s*([^|]+)\|\s*(\S+)\s*\|\s*(\S+)/);
    if (!headerMatch) return null;

    const lead = {
      id: headerMatch[1],
      studio: headerMatch[2].trim(),
      stage: headerMatch[3],
      date: headerMatch[4],
      notes: []
    };

    let section = 'fields';
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line === '### Notes') { section = 'notes'; continue; }

      if (section === 'fields') {
        const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.+)/);
        if (kvMatch) {
          let val = kvMatch[2].trim();
          if (/^\d+$/.test(val)) val = parseInt(val);
          lead[kvMatch[1]] = val;
        }
      } else if (section === 'notes') {
        lead.notes.push(line);
      }
    }
    return lead;
  }).filter(Boolean);
}

function parsePolicy(content) {
  if (!content) return {};
  const policy = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(': ');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 2).trim();
    // Type coercion
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^\d+$/.test(val)) val = parseInt(val);
    else if (val.includes(',')) val = val.split(',').map(s => s.trim());
    policy[key] = val;
  }
  return policy;
}

// ═══ Routes ═══

// Health (no auth — probe endpoint)
app.get('/bridge/health', (req, res) => {
  res.json({
    status: 'ok',
    files: {
      missions: fs.existsSync(path.join(WS_PRIME, 'MISSIONS.md')),
      tasks: fs.existsSync(path.join(WS_PRIME, 'TASKS.md')),
      policy: fs.existsSync(path.join(WS_PRIME, 'POLICY.md')),
      leads: fs.existsSync(path.join(WS_QYREN, 'QYREN_LEADS.md')),
      activity_dir: fs.existsSync(path.join(WS_PRIME, 'activity')),
      memory_prime: fs.existsSync(path.join(WS_PRIME, 'memory')),
    },
    bridge_version: '1.1.0',
  });
});

// All other routes require auth
app.use('/bridge', auth);

// Missions
app.get('/bridge/missions', (req, res) => {
  const filePath = path.join(WS_PRIME, 'MISSIONS.md');
  const { content, warning, error } = readFile(filePath, 'missions');
  if (warning) return res.json({ data: [], _warning: warning });
  const missions = parseMissions(content);
  const result = error ? { data: missions, _error: error, _file: 'MISSIONS.md' } : missions;
  res.json(result);
});

app.get('/bridge/missions/:id', (req, res) => {
  const filePath = path.join(WS_PRIME, 'MISSIONS.md');
  const { content } = readFile(filePath, 'missions');
  const missions = parseMissions(content);
  const mission = missions.find(m => m.id === req.params.id);
  if (!mission) return res.status(404).json({ error: 'Mission not found' });
  res.json(mission);
});

// Tasks
app.get('/bridge/tasks', (req, res) => {
  const filePath = path.join(WS_PRIME, 'TASKS.md');
  const { content, warning, error } = readFile(filePath, 'tasks');
  if (warning) return res.json({ data: [], _warning: warning });
  const tasks = parseTasks(content);
  const result = error ? { data: tasks, _error: error, _file: 'TASKS.md' } : tasks;
  res.json(result);
});

app.get('/bridge/tasks/:id', (req, res) => {
  const filePath = path.join(WS_PRIME, 'TASKS.md');
  const { content } = readFile(filePath, 'tasks');
  const tasks = parseTasks(content);
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// Activity (with optional agent filter)
app.get('/bridge/activity/agents', (req, res) => {
  const date = req.query.date || getTodayDubai();
  const filePath = path.join(WS_PRIME, 'activity', `ACTIVITY-${date}.md`);
  const content = readFileSimple(filePath);
  if (!content) return res.json([]);
  const entries = parseActivity(content, date);
  res.json([...new Set(entries.map(e => e.agent))]);
});

app.get('/bridge/activity', (req, res) => {
  const date = req.query.date || getTodayDubai();
  const agentFilter = req.query.agent || null;
  const filePath = path.join(WS_PRIME, 'activity', `ACTIVITY-${date}.md`);
  const { content, warning, error } = readFile(filePath, `activity-${date}`);
  if (warning) return res.json({ data: [], _warning: warning, date });
  let entries = parseActivity(content, date);
  if (agentFilter) entries = entries.filter(e => e.agent === agentFilter);
  const result = error ? { data: entries, _error: error, _file: `ACTIVITY-${date}.md` } : entries;
  res.json(result);
});

// Leads
app.get('/bridge/leads', (req, res) => {
  const filePath = path.join(WS_QYREN, 'QYREN_LEADS.md');
  const { content, warning, error } = readFile(filePath, 'leads');
  if (warning) return res.json({ data: [], _warning: warning });
  const leads = parseLeads(content);
  const result = error ? { data: leads, _error: error, _file: 'QYREN_LEADS.md' } : leads;
  res.json(result);
});

app.get('/bridge/leads/:id', (req, res) => {
  const filePath = path.join(WS_QYREN, 'QYREN_LEADS.md');
  const { content } = readFile(filePath, 'leads');
  const leads = parseLeads(content);
  const lead = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

// Policy
app.get('/bridge/policy', (req, res) => {
  const filePath = path.join(WS_PRIME, 'POLICY.md');
  const { content, warning, error } = readFile(filePath, 'policy');
  if (warning) return res.json({ _warning: warning });
  const policy = parsePolicy(content);
  const result = error ? { ...policy, _error: error, _file: 'POLICY.md' } : policy;
  res.json(result);
});

// Memory logs
app.get('/bridge/memory/dates', (req, res) => {
  const agent = req.query.agent || 'prime';
  const wsPath = AGENT_WORKSPACES[agent];
  if (!wsPath) return res.status(400).json({ error: 'unknown agent' });
  const memDir = path.join(wsPath, 'memory');
  try {
    const files = fs.readdirSync(memDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .map(f => f.replace('.md', ''))
      .sort()
      .reverse();
    res.json(files);
  } catch { res.json([]); }
});

app.get('/bridge/memory', (req, res) => {
  const date = req.query.date || getTodayDubai();
  const results = Object.entries(AGENT_WORKSPACES).map(([agent, wsPath]) => {
    const filePath = path.join(wsPath, 'memory', `${date}.md`);
    const content = readFileSimple(filePath);
    return { agent, date, content, exists: content !== null };
  });
  res.json(results);
});

// Docs directory scan
app.get('/bridge/docs', (req, res) => {
  const type = req.query.type;
  if (!type || !DOC_DIRS[type]) {
    const all = [];
    for (const [t, dir] of Object.entries(DOC_DIRS)) {
      all.push(...scanDocDir(dir, t));
    }
    return res.json(all.sort((a, b) => new Date(b.modified) - new Date(a.modified)));
  }
  res.json(scanDocDir(DOC_DIRS[type], type));
});

// Notify — send Telegram message to Prime HQ thread
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.post('/bridge/notify', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: '-1003883697402',
          message_thread_id: 2,
          text: message,
        }),
      }
    );
    const data = await r.json();
    if (!data.ok) return res.status(502).json({ error: 'telegram error', detail: data });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'notify failed', detail: err.message });
  }
});

// Start
app.listen(PORT, HOST, () => {
  console.log(`evo-bridge listening on ${HOST}:${PORT}`);
  console.log(`Workspace prime: ${WS_PRIME}`);
  console.log(`Workspace qyren: ${WS_QYREN}`);
  console.log(`Auth: ${EVO_API_KEY ? 'configured' : 'NOT SET — all requests will 500'}`);
});
