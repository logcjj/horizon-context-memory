#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const ROOT = process.env.HCM_HOME || path.join(os.homedir(), '.codex', 'hcm');
const DATA = path.join(ROOT, 'data');
const BIN = path.join(ROOT, 'bin', 'hcm-core');
const MEMORIES = path.join(DATA, 'memories.json');
const USER_MD = path.join(DATA, 'USER.md');
const MEMORY_MD = path.join(DATA, 'MEMORY.md');
const PORT = Number(process.env.HCM_WEB_PORT || process.argv.find(a => /^--port=/.test(a))?.split('=')[1] || 38987);
const CONFIG = path.join(ROOT, 'config.json');
const AUDIT = path.join(DATA, 'audit.jsonl');
const AUTO_MAINTENANCE = path.join(DATA, 'web-auto-maintenance.json');
let maintenanceRunning = false;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function nowIso() { return new Date().toISOString(); }
function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function cleanText(text) { return String(text || '').replace(/^\s*(记住|请记住|remember)[:：]?\s*/i, '').replace(/\s+/g, ' ').trim().replace(/[。.!！?？]+$/u, '。'); }
function loadStore() { const store = readJson(MEMORIES, { schema: 2, memories: [] }); return Array.isArray(store.memories) ? store : { schema: 2, memories: [] }; }
function memoryId(memory) { return sha(`${memory.domain}|${memory.scope}|${memory.project}|${memory.type}|${memory.text}`.toLowerCase()).slice(0, 16); }
function isExpired(memory) { return Boolean(memory.expiresAt && Date.parse(memory.expiresAt) < Date.now()); }
function inferLifecycle(memory) {
  const text = String(memory.text || '');
  if (/永久|一直|总是|always|forever|permanent/i.test(text)) return 'permanent';
  if (/本周|本月|临时|暂时|today|this week|this month|temporary|for now/i.test(text)) return 'short';
  if (memory.scope === 'global' || memory.type === 'preference') return 'long';
  return 'project';
}
function lifecycleAudit(memory) {
  const lastSeen = Date.parse(memory.lastSeen || memory.created || 0) || 0;
  const ageDays = lastSeen ? Math.floor((Date.now() - lastSeen) / 86400000) : 0;
  const tier = memory.lifecycle || inferLifecycle(memory);
  const reasons = [];
  if (isExpired(memory)) reasons.push('expired');
  if (memory.status === 'disabled') reasons.push('disabled');
  if (tier !== 'permanent' && ageDays > 90 && Number(memory.usedCount || 0) === 0) reasons.push('stale_unused_90d');
  if (tier === 'short' && ageDays > 14) reasons.push('short_memory_old');
  if (Number(memory.hits || 0) <= 1 && Number(memory.usedCount || 0) === 0 && tier !== 'permanent' && ageDays > 30) reasons.push('low_evidence_unused');
  return { tier, ageDays, cleanup: reasons.length > 0, reasons };
}
function syncMarkdown(store = loadStore()) {
  ensureDir(DATA);
  const user = store.memories.filter(m => m.domain === 'user' && m.status !== 'disabled');
  const memory = store.memories.filter(m => m.domain === 'memory' && m.status !== 'disabled');
  fs.writeFileSync(USER_MD, ['# USER.md', '', 'Horizon Context Memory 自动维护的用户偏好记忆。', '', ...user.map(m => `- [${m.id}] (${m.type}, ${m.confidence ?? ''}) ${m.text}`), ''].join('\n'));
  fs.writeFileSync(MEMORY_MD, ['# MEMORY.md', '', 'Horizon Context Memory 自动维护的项目、环境、流程记忆。', '', ...memory.map(m => `- [${m.id}] (${m.project}, ${m.type}, ${m.confidence ?? ''}) ${m.text}`), ''].join('\n'));
}
function saveStore(store) { writeJson(MEMORIES, store); syncMarkdown(store); }
function loadConfig() { return readJson(CONFIG, {}); }
function saveConfig(patch) {
  const allowed = new Set(['enabled', 'capturePrompts', 'captureToolEvents', 'injectSessionContext', 'autoPromoteMemories', 'autoLlmReview', 'autoCreateSkillProposals', 'autoInstallSkills', 'autoMineMemoryCandidates', 'webAutoMaintenance', 'memoryMinConfidence', 'maxStoredMemories', 'maxEnabledMemories', 'maxRetrievedMemories', 'skillProposalThreshold', 'memoryCandidateThreshold']);
  const next = { ...loadConfig() };
  for (const [key, value] of Object.entries(patch || {})) if (allowed.has(key)) next[key] = value;
  writeJson(CONFIG, next);
  return next;
}
function usage(domain, store = loadStore()) {
  const limit = domain === 'user' ? 24000 : 64000;
  const enabled = store.memories.filter(m => m.domain === domain && m.status !== 'disabled');
  const chars = enabled.reduce((sum, m) => sum + String(m.text || '').length, 0);
  return { count: enabled.length, chars, limit, percent: limit ? Math.round(chars / limit * 100) : 0 };
}

function quality(memory) {
  const text = String(memory.text || '');
  let score = 100;
  const reasons = [];
  if (text.length < 8) { score -= 35; reasons.push('too_short'); }
  if (text.length > 220) { score -= 20; reasons.push('too_long'); }
  if (/这次|临时|暂时|今天先|for now|temporary/i.test(text)) { score -= 45; reasons.push('temporary_signal'); }
  if (/token|password|secret|api[_-]?key|sk-[a-z0-9_-]{8,}/i.test(text)) { score -= 80; reasons.push('sensitive_signal'); }
  if (!/[。.!！?？]$/.test(text)) { score -= 5; reasons.push('not_sentence_like'); }
  if (isExpired(memory)) { score -= 50; reasons.push('expired'); }
  if (memory.review) { score -= 20; reasons.push('review_flag'); }
  score = Math.max(0, Math.min(100, score));
  return { score, reasons };
}
function recallExplanation(memory) {
  const audit = lifecycleAudit(memory);
  const reasons = [];
  if (memory.domain === 'user') reasons.push('用户偏好默认跨项目可用');
  if (memory.project && memory.project !== 'global') reasons.push(`项目匹配：${memory.project}`);
  if (memory.scope) reasons.push(`范围：${memory.scope}`);
  if (memory.type) reasons.push(`类型：${memory.type}`);
  if (memory.evidence_event_ids?.length) reasons.push(`证据 ${memory.evidence_event_ids.length} 条`);
  if (memory.usedCount) reasons.push(`已注入 ${memory.usedCount} 次`);
  if (memory.review) reasons.push(`待复核：${memory.review}`);
  if (audit.cleanup) reasons.push(`建议清理：${audit.reasons.join(', ')}`);
  return reasons;
}
function enrich(memory) {
  return { ...memory, lifecycle: memory.lifecycle || inferLifecycle(memory), lifecycle_audit: memory.lifecycle_audit || lifecycleAudit(memory), quality: quality(memory), recall: recallExplanation(memory) };
}
function appendAudit(action, detail) {
  ensureDir(DATA);
  const ts = nowIso();
  const memoryId = detail?.id || detail?.before?.id || detail?.after?.id || null;
  const entry = { ...detail, id: sha(JSON.stringify([ts, action, memoryId, detail?.before, detail?.after])).slice(0, 20), memory_id: memoryId, ts, actor: 'web-ui', action };
  fs.appendFileSync(AUDIT, JSON.stringify(entry) + '\n');
  return entry;
}
function readAudit(limit = 100) {
  if (!fs.existsSync(AUDIT)) return [];
  return fs.readFileSync(AUDIT, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).slice(-limit).reverse();
}
function patchMemory(memory, data) {
  if ('status' in data) memory.status = data.status === 'disabled' ? 'disabled' : 'enabled';
  if ('text' in data) memory.text = cleanText(data.text);
  if ('type' in data) memory.type = data.type || memory.type;
  if ('scope' in data) memory.scope = data.scope || memory.scope;
  if ('project' in data) memory.project = data.project || memory.project;
  if ('expiresAt' in data) memory.expiresAt = data.expiresAt || null;
  if ('lifecycle' in data) memory.lifecycle = data.lifecycle || null;
  if ('review' in data) memory.review = data.review || undefined;
  if ('review_reason' in data) memory.review_reason = data.review_reason || undefined;
  memory.updated = nowIso();
  return memory;
}
function backupStore() {
  ensureDir(path.join(DATA, 'backups'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DATA, 'backups', `memories-${stamp}.json`);
  if (!fs.existsSync(MEMORIES)) writeJson(MEMORIES, { schema: 2, memories: [] });
  fs.copyFileSync(MEMORIES, file);
  return file;
}
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function dosTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const year = Math.max(1980, date.getFullYear());
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}
function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/^\/+/, '').replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const statDate = entry.date || new Date();
    const stamp = dosTime(statDate);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
function collectFiles(root, prefix, entries, maxFiles = 1000) {
  if (!fs.existsSync(root) || entries.length >= maxFiles) return;
  for (const item of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, item.name);
    const relative = `${prefix}/${item.name}`;
    if (item.isDirectory()) collectFiles(file, relative, entries, maxFiles);
    else if (item.isFile()) entries.push({ name: relative, data: fs.readFileSync(file), date: fs.statSync(file).mtime });
  }
}
function memoryExportZip() {
  syncMarkdown();
  const store = loadStore();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const entries = [
    {
      name: 'manifest.json',
      data: JSON.stringify({
        name: 'Horizon Context Memory export',
        schema: 1,
        exportedAt: nowIso(),
        memories: store.memories.length,
        userMemories: store.memories.filter(memory => memory.domain === 'user').length,
        projectMemories: store.memories.filter(memory => memory.domain === 'memory').length,
        disabledMemories: store.memories.filter(memory => memory.status === 'disabled').length,
      }, null, 2) + '\n',
    },
    {
      name: 'README_IMPORT.txt',
      data: [
        'Horizon Context Memory export',
        '',
        'To migrate manually:',
        '1. Install HCM on the target machine.',
        '2. Stop the target HCM web server if it is running.',
        '3. Copy data/* into ~/.codex/hcm/data/ and skills/* into ~/.codex/hcm/skills/ when present.',
        '4. Run hcm and verify the memory count in the web cockpit.',
        '',
        'This archive may contain private memories, event snippets, audit history, and local workflow notes. Treat it as sensitive local data.',
        '',
      ].join('\n'),
    },
  ];
  for (const [source, name] of [
    [MEMORIES, 'data/memories.json'],
    [USER_MD, 'data/USER.md'],
    [MEMORY_MD, 'data/MEMORY.md'],
    [CONFIG, 'config.json'],
    [AUDIT, 'data/audit.jsonl'],
    [AUTO_MAINTENANCE, 'data/web-auto-maintenance.json'],
    [path.join(DATA, 'auto-state.json'), 'data/auto-state.json'],
    [path.join(DATA, 'sessions.sqlite'), 'data/sessions.sqlite'],
  ]) {
    if (fs.existsSync(source)) entries.push({ name, data: fs.readFileSync(source), date: fs.statSync(source).mtime });
  }
  collectFiles(path.join(DATA, 'events'), 'data/events', entries);
  collectFiles(path.join(DATA, 'backups'), 'data/backups', entries);
  collectFiles(path.join(ROOT, 'skills', 'proposals'), 'skills/proposals', entries);
  return { filename: `hcm-memory-export-${stamp}.zip`, buffer: zipBuffer(entries) };
}
function pendingBucket(memory) {
  if (memory.status === 'disabled') return 'disabled';
  if (memory.review === 'auto-candidate') return 'candidate';
  if (memory.review) return 'review';
  if (quality(memory).score < 60) return 'lowQuality';
  if (lifecycleAudit(memory).cleanup) return 'cleanupSuggested';
  return null;
}
function status() {
  const store = loadStore();
  const pendingBuckets = { review: 0, candidate: 0, cleanupSuggested: 0, lowQuality: 0, disabled: 0 };
  for (const memory of store.memories) {
    const bucket = pendingBucket(memory);
    if (bucket) pendingBuckets[bucket] += 1;
  }
  return {
    root: ROOT,
    total: store.memories.length,
    disabled: store.memories.filter(m => m.status === 'disabled').length,
    review: store.memories.filter(m => m.review).length,
    lowQuality: store.memories.filter(m => quality(m).score < 60).length,
    candidate: store.memories.filter(m => m.review === 'auto-candidate').length,
    cleanupSuggested: store.memories.filter(m => lifecycleAudit(m).cleanup).length,
    pending: Object.values(pendingBuckets).reduce((sum, count) => sum + count, 0),
    pendingBuckets,
    user: usage('user', store),
    memory: usage('memory', store),
    depth: {
      stored: store.memories.length,
      maxStored: Number(loadConfig().maxStoredMemories || 5000),
      retrieved: Number(loadConfig().maxRetrievedMemories || 24),
      enabledMax: Number(loadConfig().maxEnabledMemories || 2000),
    },
    autoMaintenance: readJson(AUTO_MAINTENANCE, {}),
    userFile: USER_MD,
    memoryFile: MEMORY_MD,
  };
}
function runCommand(args, timeout = 180000) {
  try { return { ok: true, output: execFileSync(BIN, args, { cwd: process.cwd(), encoding: 'utf8', timeout }) }; }
  catch (error) { return { ok: false, error: error.message, output: error.stdout?.toString() || error.stderr?.toString() || '' }; }
}
function safeProposalPath(file) {
  const dir = path.join(ROOT, 'skills', 'proposals');
  const resolved = path.resolve(String(file || ''));
  const root = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(root) || !resolved.endsWith('.md')) throw new Error('invalid proposal path');
  return resolved;
}

function eventCount() {
  return readJsonlFiles(path.join(DATA, 'events'), 365).length;
}
function autoMaintenanceDue() {
  const cfg = loadConfig();
  if (cfg.webAutoMaintenance === false) return { due: false, reason: 'disabled' };
  if (maintenanceRunning) return { due: false, reason: 'running' };
  const previous = readJson(AUTO_MAINTENANCE, {});
  const events = eventCount();
  const memories = loadStore().memories.length;
  const last = Date.parse(previous.lastRunAt || 0) || 0;
  const eventDelta = events - Number(previous.eventCount || 0);
  const memoryDelta = memories - Number(previous.memoryCount || 0);
  const hoursSince = last ? (Date.now() - last) / 3600000 : Infinity;
  if (!last || eventDelta >= 8 || memoryDelta >= 3 || hoursSince >= 6) return { due: true, events, memories, eventDelta, memoryDelta, hoursSince };
  return { due: false, reason: 'not-due', events, memories, eventDelta, memoryDelta, hoursSince };
}
function startAutoMaintenance(trigger = 'web-state') {
  const due = autoMaintenanceDue();
  if (!due.due) return due;
  maintenanceRunning = true;
  let backup = null;
  try {
    const previous = readJson(AUTO_MAINTENANCE, {});
    const lastBackup = Date.parse(previous.lastBackupAt || 0) || 0;
    if (!lastBackup || Date.now() - lastBackup > 86400000 || due.memoryDelta >= 3) backup = backupStore();
    writeJson(AUTO_MAINTENANCE, { ...previous, running: true, startedAt: nowIso(), trigger, eventCount: due.events, memoryCount: due.memories, lastBackupAt: backup ? nowIso() : previous.lastBackupAt, lastBackupFile: backup || previous.lastBackupFile });
  } catch {}
  const child = spawn(BIN, ['evolve'], { cwd: process.cwd(), env: { ...process.env, HCM_WEB_AUTO: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk.toString());
  child.stderr.on('data', chunk => output += chunk.toString());
  child.on('close', code => {
    maintenanceRunning = false;
    const events = eventCount();
    const memories = loadStore().memories.length;
    const previous = readJson(AUTO_MAINTENANCE, {});
    const health = runCommand(['health'], 30000);
    writeJson(AUTO_MAINTENANCE, {
      ...previous,
      running: false,
      lastRunAt: nowIso(),
      eventCount: events,
      memoryCount: memories,
      lastExitCode: code,
      lastOutput: output.slice(-4000),
      lastHealth: health,
    });
  });
  child.on('error', error => {
    maintenanceRunning = false;
    const previous = readJson(AUTO_MAINTENANCE, {});
    writeJson(AUTO_MAINTENANCE, { ...previous, running: false, lastRunAt: nowIso(), lastError: error.message });
  });
  return { ...due, started: true, backup };
}

function readJsonlFiles(dir, maxFiles = 365) {
  ensureDir(dir);
  return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort().slice(-maxFiles).flatMap(name => {
    const file = path.join(dir, name);
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  });
}
function evidenceIdsFor(ids = [], store = loadStore()) {
  const wanted = new Set();
  for (const id of ids.filter(Boolean)) {
    wanted.add(id);
    const memory = store.memories.find(m => m.id === id);
    for (const eventId of memory?.evidence_event_ids || []) wanted.add(eventId);
  }
  return wanted;
}
function findEvidence(ids = []) {
  const wanted = evidenceIdsFor(ids);
  if (wanted.size === 0) return [];
  return readJsonlFiles(path.join(DATA, 'events')).filter(e => wanted.has(e.event_id));
}
function listProposals() {
  const dir = path.join(ROOT, 'skills', 'proposals');
  try {
    return fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort().map(n => {
      const file = path.join(dir, n);
      const text = fs.readFileSync(file, 'utf8');
      const stat = fs.statSync(file);
      return { name: n, file, mtime: stat.mtime.toISOString(), title: text.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^"|"$/g, '') || n, source_memory: text.match(/^source_memory:\s*(.+)$/m)?.[1] || null, preview: text.split('\n').slice(0, 12).join('\n') };
    });
  } catch { return []; }
}
function send(res, code, data, type = 'application/json') {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}
function sendDownload(res, filename, buffer) {
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': buffer.length,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}
function body(req) { return new Promise(resolve => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } }); }); }
function html() { return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); }
function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;
  if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
}
function existingServerLooksHealthy(url) {
  try {
    execFileSync(process.execPath, ['-e', `
      const url = process.argv[1];
      Promise.all([
        fetch(url, { signal: AbortSignal.timeout(1200) }).then(r => r.text()),
        fetch(url + '/api/state', { signal: AbortSignal.timeout(1200) }).then(r => r.json())
      ])
        .then(([html, data]) => {
          const titleOk = /<title>Horizon Context Memory<\\/title>/.test(html);
          process.exit(titleOk && data && data.status ? 0 : 3);
        })
        .catch(() => process.exit(4));
    `, url], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, html(), 'text/html');
  if (req.method === 'GET' && url.pathname === '/api/export.zip') {
    try {
      const archive = memoryExportZip();
      return sendDownload(res, archive.filename, archive.buffer);
    } catch (error) {
      return send(res, 500, { ok: false, error: error.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    syncMarkdown();
    startAutoMaintenance();
    const store = loadStore();
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const domain = url.searchParams.get('domain') || 'all';
    const state = url.searchParams.get('state') || 'all';
    const scope = url.searchParams.get('scope') || 'all';
    const type = url.searchParams.get('type') || 'all';
    const memories = store.memories.filter(m => {
      if (domain !== 'all' && m.domain !== domain) return false;
      if (state === 'on' && m.status === 'disabled') return false;
      if (state === 'off' && m.status !== 'disabled') return false;
      if (state === 'review' && !m.review && quality(m).score >= 60 && m.status !== 'disabled' && !lifecycleAudit(m).cleanup) return false;
      if (state === 'candidate' && m.review !== 'auto-candidate') return false;
      if (state === 'cleanup' && !lifecycleAudit(m).cleanup) return false;
      if (state === 'expired' && !isExpired(m)) return false;
      if (state === 'low' && quality(m).score >= 60) return false;
      if (scope !== 'all' && (m.scope || '') !== scope) return false;
      if (type !== 'all' && (m.type || '') !== type) return false;
      if (q && !`${m.id} ${m.text} ${m.project} ${m.type} ${m.scope} ${m.evidence} ${m.review_reason}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const facets = {
      scopes: [...new Set(store.memories.map(m => m.scope).filter(Boolean))].sort(),
      types: [...new Set(store.memories.map(m => m.type).filter(Boolean))].sort(),
    };
    return send(res, 200, { status: status(), config: loadConfig(), facets, memories: memories.map(enrich) });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/config') return send(res, 200, { ok: true, config: saveConfig(await body(req)) });
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const q = url.searchParams.get('q') || '';
    const result = runCommand(['search', q], 30000);
    return send(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/memory') {
    const data = await body(req);
    const store = loadStore();
    const domain = data.domain === 'memory' ? 'memory' : 'user';
    const memory = {
      domain,
      type: data.type || (domain === 'user' ? 'preference' : 'manual'),
      scope: data.scope || (domain === 'memory' ? 'project' : 'global'),
      project: domain === 'memory' ? (data.project || process.cwd().replace(os.homedir(), '~')) : 'global',
      text: cleanText(data.text),
      confidence: 1,
      evidence: 'web-ui',
      evidence_event_ids: [],
      expiresAt: data.expiresAt || null,
      lifecycle: data.lifecycle || null,
      status: 'enabled',
      created: nowIso(),
      lastSeen: nowIso(),
      hits: 1,
      source: 'web-ui',
      cwd: process.cwd(),
    };
    memory.id = memoryId(memory);
    if (!memory.text) return send(res, 400, { ok: false, error: 'empty text' });
    if (!store.memories.some(m => m.id === memory.id)) { store.memories.unshift(memory); appendAudit('create', { id: memory.id, after: memory }); }
    saveStore(store);
    return send(res, 200, { ok: true, memory });
  }
  if (req.method === 'POST' && url.pathname === '/api/memory/purge-disabled') {
    const store = loadStore();
    const disabled = store.memories.filter(m => m.status === 'disabled');
    if (!disabled.length) return send(res, 200, { ok: true, deleted: 0, ids: [] });
    const backup = backupStore();
    const ids = new Set(disabled.map(m => m.id));
    store.memories = store.memories.filter(m => !ids.has(m.id));
    for (const memory of disabled) appendAudit('purge-disabled', { id: memory.id, before: memory, backup });
    saveStore(store);
    return send(res, 200, { ok: true, deleted: disabled.length, ids: [...ids], backup });
  }
  const match = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
  if (match && req.method === 'PATCH') {
    const id = match[1];
    const data = await body(req);
    const store = loadStore();
    const memory = store.memories.find(m => m.id === id);
    if (!memory) return send(res, 404, { ok: false, error: 'not found' });
    const before = JSON.parse(JSON.stringify(memory));
    patchMemory(memory, data);
    appendAudit('update', { id, before, after: memory });
    saveStore(store);
    return send(res, 200, { ok: true, memory });
  }
  if (req.method === 'POST' && url.pathname === '/api/memory/batch') {
    const data = await body(req);
    const ids = Array.isArray(data.ids) ? data.ids.filter(Boolean) : [];
    const action = String(data.action || '');
    const store = loadStore();
    const changed = [];
    if (!ids.length) return send(res, 400, { ok: false, error: 'no ids' });
    if (action === 'delete') {
      const before = store.memories.filter(m => ids.includes(m.id));
      store.memories = store.memories.filter(m => !ids.includes(m.id));
      for (const memory of before) appendAudit('batch-delete', { id: memory.id, before: memory });
      saveStore(store);
      return send(res, 200, { ok: true, changed: before.length });
    }
    for (const memory of store.memories.filter(m => ids.includes(m.id))) {
      const before = JSON.parse(JSON.stringify(memory));
      if (action === 'enable') patchMemory(memory, { status: 'enabled', review: undefined, review_reason: undefined });
      else if (action === 'disable') patchMemory(memory, { status: 'disabled' });
      else if (action === 'clear-review') patchMemory(memory, { review: undefined, review_reason: undefined });
      else return send(res, 400, { ok: false, error: 'unknown action' });
      appendAudit(`batch-${action}`, { id: memory.id, before, after: memory });
      changed.push(memory.id);
    }
    saveStore(store);
    return send(res, 200, { ok: true, changed: changed.length, ids: changed });
  }
  if (match && req.method === 'DELETE') {
    const id = match[1];
    const store = loadStore();
    const beforeMemory = store.memories.find(m => m.id === id);
    const before = store.memories.length;
    store.memories = store.memories.filter(m => m.id !== id);
    if (beforeMemory) appendAudit('delete', { id, before: beforeMemory });
    saveStore(store);
    return send(res, 200, { ok: store.memories.length < before });
  }
  if (req.method === 'GET' && url.pathname === '/api/audit') return send(res, 200, { audit: readAudit(Number(url.searchParams.get('limit') || 100)) });
  if (req.method === 'POST' && url.pathname === '/api/audit/restore') {
    const data = await body(req);
    const entry = readAudit(1000).find(x => x.id === data.audit_id);
    if (!entry || !entry.before) return send(res, 404, { ok: false, error: 'restorable audit entry not found' });
    const store = loadStore();
    const restored = { ...entry.before, status: 'disabled', review: 'restored-from-audit', review_reason: `Restored from audit ${entry.id}`, updated: nowIso() };
    const existingIndex = store.memories.findIndex(m => m.id === restored.id);
    if (existingIndex >= 0) store.memories[existingIndex] = restored;
    else store.memories.unshift(restored);
    const restoredMemories = [restored.id];
    if (entry.merged?.id && !store.memories.some(m => m.id === entry.merged.id)) {
      const restoredMerged = { ...entry.merged, status: 'disabled', review: 'restored-from-audit', review_reason: `Restored merged memory from audit ${entry.id}`, updated: nowIso() };
      store.memories.unshift(restoredMerged);
      restoredMemories.push(restoredMerged.id);
    }
    appendAudit('restore', { id: restored.id, audit_id: entry.id, restored: restoredMemories, after: restored });
    saveStore(store);
    return send(res, 200, { ok: true, memory: restored, restored: restoredMemories });
  }
  if (req.method === 'GET' && url.pathname === '/api/evidence') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    return send(res, 200, { events: findEvidence(ids) });
  }
  if (req.method === 'GET' && url.pathname === '/api/proposals') return send(res, 200, { proposals: listProposals() });
  if (req.method === 'POST' && url.pathname === '/api/proposals/install') {
    try {
      const data = await body(req);
      const file = safeProposalPath(data.file);
      return send(res, 200, runCommand(['install-skill', file], 30000));
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/summary') return send(res, 200, runCommand(['context', process.cwd(), 'project startup summary'], 30000));
  if (req.method === 'POST' && url.pathname === '/api/reindex') return send(res, 200, runCommand(['reindex'], 30000));
  if (req.method === 'POST' && url.pathname === '/api/backup') { try { return send(res, 200, { ok: true, file: backupStore() }); } catch (error) { return send(res, 500, { ok: false, error: error.message }); } }
  if (req.method === 'POST' && url.pathname === '/api/consolidate') return send(res, 200, runCommand(['consolidate'], 30000));
  if (req.method === 'POST' && url.pathname === '/api/evolve') return send(res, 200, runCommand(['evolve'], 60000));
  if (req.method === 'POST' && url.pathname === '/api/health') return send(res, 200, runCommand(['health'], 30000));
  if (req.method === 'POST' && url.pathname === '/api/llm-review') return send(res, 200, runCommand(['llm-review'], 240000));
  return send(res, 404, { ok: false, error: 'not found' });
});

server.on('error', error => {
  const url = `http://127.0.0.1:${PORT}`;
  if (error.code === 'EADDRINUSE' && existingServerLooksHealthy(url)) {
    console.log(`Horizon Context Memory web UI already running: ${url}`);
    openBrowser(url);
    return;
  }
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use by another process.`);
    console.error(`Stop it or run with another port, for example: HCM_WEB_PORT=38988 hcm`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Horizon Context Memory web UI: ${url}`);
  openBrowser(url);
});
