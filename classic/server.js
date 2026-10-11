#!/usr/bin/env node
//
// NightCrew Web UI Server
// Started via: nightcrew serve [--port PORT]
//
// Reads/writes local YAML and JSON files. No database.
// All state lives on the filesystem in state/, logs/, tasks.yaml, config.yaml.
//

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const yaml = require('js-yaml');

const NIGHTCREW_DIR = process.env.NIGHTCREW_DIR || path.dirname(__filename);
const TASKS_FILE = process.env.TASKS_FILE || path.join(NIGHTCREW_DIR, 'tasks.yaml');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(NIGHTCREW_DIR, 'config.yaml');
const PORT = parseInt(process.env.SERVE_PORT || '3721', 10);

// Track active run process
let activeRun = null;

// ── Helpers ────────────────────────────────────────────────

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errorResponse(res, message, status = 500) {
  jsonResponse(res, { error: message }, status);
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Request body too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Validate that a path segment doesn't escape its parent (no path traversal)
function isSafePathSegment(segment) {
  return segment && !segment.includes('..') && !segment.includes('/') && !segment.includes('\\') && !segment.includes('\0');
}

function parseRoute(url) {
  const [pathname, query] = url.split('?');
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  return { parts, query: query || '' };
}

// ── API Handlers ──────────────────────────────────────────

// GET /api/tasks — read tasks.yaml as JSON
function getTasks(req, res) {
  try {
    const content = fs.readFileSync(TASKS_FILE, 'utf8');
    const data = yaml.load(content);
    jsonResponse(res, { tasks: (data && data.tasks) || [] });
  } catch (err) {
    if (err.code === 'ENOENT') {
      jsonResponse(res, { tasks: [] });
    } else {
      errorResponse(res, 'Failed to read tasks: ' + err.message);
    }
  }
}

// POST /api/tasks — write tasks.yaml from JSON body
async function postTasks(req, res) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const yamlStr = yaml.dump(data, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(TASKS_FILE, yamlStr, 'utf8');
    jsonResponse(res, { ok: true });
  } catch (err) {
    errorResponse(res, 'Failed to write tasks: ' + err.message, 400);
  }
}

// GET /api/status — read current progress.json
function getStatus(req, res) {
  const stateFile = path.join(NIGHTCREW_DIR, 'state', 'progress.json');
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    jsonResponse(res, {
      ...data,
      tasks: data.tasks || {},
      total_cost_cents: data.total_cost_cents || 0,
      session_started: data.session_started || null,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      jsonResponse(res, { tasks: {}, total_cost_cents: 0, session_started: null });
    } else {
      errorResponse(res, 'Failed to read status: ' + err.message);
    }
  }
}

// GET /api/sessions — list archived sessions
function getSessions(req, res) {
  const sessionsDir = path.join(NIGHTCREW_DIR, 'state', 'sessions');
  try {
    if (!fs.existsSync(sessionsDir)) {
      jsonResponse(res, { sessions: [] });
      return;
    }
    const dirs = fs.readdirSync(sessionsDir)
      .filter(d => fs.statSync(path.join(sessionsDir, d)).isDirectory())
      .sort()
      .reverse();

    const sessions = dirs.map(id => {
      const progressFile = path.join(sessionsDir, id, 'progress.json');
      try {
        const data = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        const tasks = data.tasks || {};
        const taskCount = Object.keys(tasks).length;
        const statuses = {};
        for (const t of Object.values(tasks)) {
          statuses[t.status] = (statuses[t.status] || 0) + 1;
        }
        return {
          id,
          session_started: data.session_started,
          task_count: taskCount,
          total_cost_cents: data.total_cost_cents || 0,
          statuses
        };
      } catch {
        return { id, session_started: id, task_count: 0, total_cost_cents: 0, statuses: {} };
      }
    });

    jsonResponse(res, { sessions });
  } catch (err) {
    errorResponse(res, 'Failed to list sessions: ' + err.message);
  }
}

// GET /api/sessions/:id — read a specific session's progress.json
function getSession(req, res, sessionId) {
  if (!isSafePathSegment(sessionId)) { errorResponse(res, 'Invalid session ID', 400); return; }
  const progressFile = path.join(NIGHTCREW_DIR, 'state', 'sessions', sessionId, 'progress.json');
  try {
    const data = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    jsonResponse(res, data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      errorResponse(res, 'Session not found: ' + sessionId, 404);
    } else {
      errorResponse(res, 'Failed to read session: ' + err.message);
    }
  }
}

// GET /api/logs/:session/:file — stream a log file
function getLog(req, res, sessionId, filename) {
  if (!isSafePathSegment(sessionId)) { errorResponse(res, 'Invalid session ID', 400); return; }
  // Sanitize: prevent path traversal
  if (!isSafePathSegment(filename)) {
    errorResponse(res, 'Invalid filename', 400);
    return;
  }
  const logPath = path.join(NIGHTCREW_DIR, 'state', 'sessions', sessionId, 'logs', filename);
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      errorResponse(res, 'Log not found', 404);
    } else {
      errorResponse(res, 'Failed to read log: ' + err.message);
    }
  }
}

// GET /api/logs/:session — list log files in a session
function listLogs(req, res, sessionId) {
  if (!isSafePathSegment(sessionId)) { errorResponse(res, 'Invalid session ID', 400); return; }
  const logsDir = path.join(NIGHTCREW_DIR, 'state', 'sessions', sessionId, 'logs');
  try {
    if (!fs.existsSync(logsDir)) {
      jsonResponse(res, { logs: [] });
      return;
    }
    const files = fs.readdirSync(logsDir)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const stat = fs.statSync(path.join(logsDir, f));
        // Parse task-id and phase from filename: {task-id}-{phase}.log
        const match = f.match(/^(.+)-(plan|impl|review)\.log$/);
        return {
          filename: f,
          task_id: match ? match[1] : f,
          phase: match ? match[2] : 'unknown',
          size_bytes: stat.size,
          lines: null  // computed on demand, not here
        };
      });
    jsonResponse(res, { logs: files });
  } catch (err) {
    errorResponse(res, 'Failed to list logs: ' + err.message);
  }
}

// GET /api/config — resolved configuration
function getConfig(req, res) {
  try {
    const output = execFileSync(
      path.join(NIGHTCREW_DIR, 'nightcrew.sh'),
      ['config', '--config', CONFIG_FILE, '--json'],
      { encoding: 'utf8', timeout: 5000 }
    );
    const data = JSON.parse(output);
    jsonResponse(res, data);
  } catch (err) {
    errorResponse(res, 'Failed to read config: ' + err.message);
  }
}

// GET /api/preflight — run preflight checks
function getPreflight(req, res) {
  try {
    const output = execFileSync(
      path.join(NIGHTCREW_DIR, 'nightcrew.sh'),
      ['preflight', '--tasks', TASKS_FILE, '--config', CONFIG_FILE, '--json'],
      { encoding: 'utf8', timeout: 30000 }
    );
    const data = JSON.parse(output);
    jsonResponse(res, data);
  } catch (err) {
    errorResponse(res, 'Preflight failed: ' + err.message);
  }
}

// GET /api/version — read VERSION file
function getVersion(req, res) {
  try {
    const version = fs.readFileSync(path.join(NIGHTCREW_DIR, 'VERSION'), 'utf8').trim();
    jsonResponse(res, { version });
  } catch {
    jsonResponse(res, { version: 'unknown' });
  }
}

// POST /api/run — start a nightcrew run (non-blocking)
async function postRun(req, res) {
  if (activeRun && !activeRun.killed) {
    errorResponse(res, 'A run is already active', 409);
    return;
  }

  let opts = {};
  try {
    const body = await readBody(req);
    if (body) opts = JSON.parse(body);
  } catch { /* ignore parse errors, use defaults */ }

  const args = ['run', '--tasks', TASKS_FILE, '--config', CONFIG_FILE];
  if (opts.dry_run) args.push('--dry-run');

  const child = spawn(
    path.join(NIGHTCREW_DIR, 'nightcrew.sh'),
    args,
    { cwd: NIGHTCREW_DIR, detached: false, stdio: 'ignore' }
  );

  activeRun = child;
  child.on('exit', (code) => {
    if (activeRun === child) activeRun = null;
    if (code !== 0 && code !== null) console.error('nightcrew run exited with code ' + code);
  });
  child.on('error', (err) => {
    if (activeRun === child) activeRun = null;
    console.error('nightcrew run spawn error: ' + err.message);
  });

  jsonResponse(res, { ok: true, pid: child.pid });
}

// GET /api/run/status — check if a run is active
function getRunStatus(req, res) {
  jsonResponse(res, {
    active: activeRun !== null && !activeRun.killed,
    pid: activeRun ? activeRun.pid : null
  });
}

// ── Static File Serving ───────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  // Decode URL and resolve to absolute path
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  let filePath = path.resolve(path.join(NIGHTCREW_DIR, urlPath === '/' ? 'index.html' : urlPath));

  // Prevent path traversal
  if (!filePath.startsWith(path.resolve(NIGHTCREW_DIR))) {
    errorResponse(res, 'Forbidden', 403);
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for any non-file route
    try {
      const index = fs.readFileSync(path.join(NIGHTCREW_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(index);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

// ── Router ────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // No CORS — server only serves its own UI from the same origin
  // Reject requests with an Origin header that doesn't match localhost
  const origin = req.headers.origin;
  if (origin && !origin.match(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/)) {
    res.writeHead(403);
    res.end('Forbidden: cross-origin requests not allowed');
    return;
  }

  const { parts } = parseRoute(req.url);

  // API routes
  if (parts[0] === 'api') {
    const resource = parts[1];

    if (resource === 'tasks') {
      if (req.method === 'GET') return getTasks(req, res);
      if (req.method === 'POST') return postTasks(req, res);
    }
    if (resource === 'status' && req.method === 'GET') return getStatus(req, res);
    if (resource === 'sessions') {
      if (parts.length === 2 && req.method === 'GET') return getSessions(req, res);
      if (parts.length === 3 && req.method === 'GET') return getSession(req, res, parts[2]);
    }
    if (resource === 'logs') {
      if (parts.length === 3 && req.method === 'GET') return listLogs(req, res, parts[2]);
      if (parts.length === 4 && req.method === 'GET') return getLog(req, res, parts[2], parts[3]);
    }
    if (resource === 'config' && req.method === 'GET') return getConfig(req, res);
    if (resource === 'preflight' && req.method === 'GET') return getPreflight(req, res);
    if (resource === 'version' && req.method === 'GET') return getVersion(req, res);
    if (resource === 'run') {
      if (req.method === 'POST') return postRun(req, res);
      if (req.method === 'GET' && parts[2] === 'status') return getRunStatus(req, res);
    }

    errorResponse(res, 'Not found', 404);
    return;
  }

  // Static files / SPA
  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NightCrew UI: http://127.0.0.1:${PORT}`);
  console.log(`API:          http://127.0.0.1:${PORT}/api/`);
  console.log('Press Ctrl+C to stop.');
});
