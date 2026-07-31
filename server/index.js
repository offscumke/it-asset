const express = require('express');
const cors = require('cors');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

const app = express();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3001);

function getSecret(name, developmentDefault) {
  const value = process.env[name];
  if (value) return value;
  if (!IS_PRODUCTION) return developmentDefault;
  throw new Error(`${name} is required when NODE_ENV=production`);
}

const JWT_SECRET = getSecret('JWT_SECRET', 'dev-secret-change-me');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS_HASH = bcrypt.hashSync(getSecret('ADMIN_PASS', 'admin123'), 10);
const AGENT_SECRET = getSecret('AGENT_SECRET', 'agent-shared-secret');
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, 'assets.db'));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const PING_INTERVAL_SECONDS = Math.max(15, Number(process.env.PING_INTERVAL_SECONDS) || 60);
const PING_TIMEOUT_MS = 4000;
const ASSET_TYPES = new Set([
  'computer', 'server', 'switch', 'firewall', 'router',
  'wireless_ap', 'printer', 'storage', 'other'
]);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'error' });
  }
});

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    platform TEXT,
    ip TEXT,
    mac_address TEXT,
    cpu TEXT,
    cpu_cores INTEGER,
    ram_total INTEGER,
    ram_free INTEGER,
    disk_total INTEGER,
    disk_free INTEGER,
    os TEXT,
    os_version TEXT,
    vnc_port INTEGER DEFAULT 5900,
    location TEXT,
    department TEXT,
    owner TEXT,
    asset_tag TEXT,
    asset_type TEXT DEFAULT 'computer',
    source TEXT DEFAULT 'agent',
    manufacturer TEXT,
    model TEXT,
    serial_number TEXT,
    notes TEXT,
    ping_enabled INTEGER DEFAULT 0,
    ping_status TEXT DEFAULT 'unknown',
    last_ping_at TEXT,
    ping_latency_ms REAL,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS software (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS inventory_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS inventory_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    scanned_location TEXT,
    note TEXT,
    scanned_by TEXT,
    scanned_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(session_id) REFERENCES inventory_sessions(id),
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
`);

// Additive migration keeps databases created by earlier releases usable.
const assetColumns = {
  location: 'TEXT',
  department: 'TEXT',
  owner: 'TEXT',
  asset_tag: 'TEXT',
  asset_type: "TEXT DEFAULT 'computer'",
  source: "TEXT DEFAULT 'agent'",
  manufacturer: 'TEXT',
  model: 'TEXT',
  serial_number: 'TEXT',
  notes: 'TEXT',
  ping_enabled: 'INTEGER DEFAULT 0',
  ping_status: "TEXT DEFAULT 'unknown'",
  last_ping_at: 'TEXT',
  ping_latency_ms: 'REAL'
};
const existingAssetColumns = new Set(
  db.prepare('PRAGMA table_info(assets)').all().map(column => column.name)
);
for (const [name, definition] of Object.entries(assetColumns)) {
  if (!existingAssetColumns.has(name)) db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${definition}`);
}
db.exec(`
  UPDATE assets SET asset_type='computer' WHERE asset_type IS NULL OR asset_type='';
  UPDATE assets SET source='agent' WHERE source IS NULL OR source='';
  UPDATE assets SET ping_enabled=0 WHERE ping_enabled IS NULL;
  UPDATE assets SET ping_status='unknown' WHERE ping_status IS NULL OR ping_status='';
`);

function cleanText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeIp(value) {
  const ip = cleanText(value);
  if (ip && !net.isIP(ip)) throw new Error('IP 地址格式不正确');
  return ip;
}

function assetOnlineStatus(asset) {
  if (asset.source === 'manual') {
    if (!asset.ping_enabled || !asset.ip) return 'unknown';
    return asset.ping_status === 'online' ? 'online' :
      asset.ping_status === 'offline' ? 'offline' : 'unknown';
  }
  if (!asset.last_seen) return 'offline';
  const lastSeen = new Date(`${asset.last_seen}Z`).getTime();
  return Date.now() - lastSeen < 300000 ? 'online' : 'offline';
}

function assetResponse(asset) {
  if (!asset) return asset;
  return { ...asset, online_status: assetOnlineStatus(asset) };
}

function publicAssetResponse(asset) {
  const row = assetResponse(asset);
  if (!row) return row;
  const fields = [
    'id', 'hostname', 'asset_type', 'source', 'manufacturer', 'model',
    'serial_number', 'ip', 'mac_address', 'location', 'department', 'owner',
    'asset_tag', 'notes', 'online_status', 'last_seen', 'last_ping_at',
    'ping_latency_ms'
  ];
  return Object.fromEntries(fields.map(field => [field, row[field] ?? null]));
}

function pingHost(ip) {
  const wait = process.platform === 'darwin' ? '2000' : '2';
  const args = ['-c', '1', '-W', wait, ip];
  return new Promise(resolve => {
    const startedAt = Date.now();
    execFile(process.env.PING_BINARY || 'ping', args, { timeout: PING_TIMEOUT_MS },
      (error, stdout = '') => {
        const match = stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
        resolve({
          online: !error,
          latency_ms: match ? Number(match[1]) : (!error ? Date.now() - startedAt : null)
        });
      });
  });
}

async function checkAssetPing(asset) {
  if (!asset?.ip || !net.isIP(asset.ip)) throw new Error('资产没有有效的 IP 地址');
  const result = await pingHost(asset.ip);
  db.prepare(`UPDATE assets SET ping_status=?,last_ping_at=datetime('now'),ping_latency_ms=? WHERE id=?`)
    .run(result.online ? 'online' : 'offline', result.latency_ms, asset.id);
  return assetResponse(db.prepare('SELECT * FROM assets WHERE id=?').get(asset.id));
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'invalid token' }); }
}
function requireAgentOrAuth(req, res, next) {
  if ((req.headers.authorization || '') === `Bearer agent:${AGENT_SECRET}`) return next();
  requireAuth(req, res, next);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || !bcrypt.compareSync(password || '', ADMIN_PASS_HASH))
    return res.status(401).json({ error: '用户名或密码错误' });
  res.json({ token: jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '8h' }) });
});

// ── Agent check-in ────────────────────────────────────────────────────────────
app.post('/api/checkin', requireAgentOrAuth, (req, res) => {
  const d = req.body;
  if (!d.hostname) return res.status(400).json({ error: 'hostname required' });
  const existing = db.prepare('SELECT id FROM assets WHERE hostname=?').get(d.hostname);
  const id = existing ? existing.id : uuidv4();
  db.prepare(`
    INSERT INTO assets (id,hostname,platform,ip,mac_address,cpu,cpu_cores,
      ram_total,ram_free,disk_total,disk_free,os,os_version,vnc_port,
      asset_type,source,ping_enabled,ping_status,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'computer','agent',0,'unknown',datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      platform=excluded.platform,ip=excluded.ip,mac_address=excluded.mac_address,
      cpu=excluded.cpu,cpu_cores=excluded.cpu_cores,ram_total=excluded.ram_total,
      ram_free=excluded.ram_free,disk_total=excluded.disk_total,disk_free=excluded.disk_free,
      os=excluded.os,os_version=excluded.os_version,vnc_port=excluded.vnc_port,
      asset_type='computer',source='agent',ping_enabled=0,ping_status='unknown',
      last_seen=datetime('now')
  `).run(id,d.hostname,d.platform||null,d.ip||null,d.mac_address||null,
    d.cpu||null,d.cpu_cores||null,d.ram_total||null,d.ram_free||null,
    d.disk_total||null,d.disk_free||null,d.os||null,d.os_version||null,d.vnc_port||5900);
  if (Array.isArray(d.software)) {
    db.prepare('DELETE FROM software WHERE asset_id=?').run(id);
    const ins = db.prepare('INSERT INTO software (asset_id,name,version) VALUES (?,?,?)');
    for (const s of d.software) ins.run(id, s.name, s.version || '');
  }
  res.json({ id });
});

// ── Assets CRUD ───────────────────────────────────────────────────────────────
app.get('/api/assets', requireAuth, (req, res) => {
  const assets = db.prepare(`
    SELECT * FROM assets
    ORDER BY COALESCE(last_seen,last_ping_at,created_at) DESC, hostname
  `).all();
  res.json(assets.map(assetResponse));
});

app.get('/api/assets/:id', requireAuth, (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'not found' });
  asset.software = db.prepare('SELECT name,version FROM software WHERE asset_id=? ORDER BY name').all(asset.id);
  res.json(assetResponse(asset));
});

app.get('/api/public/assets/:id', (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'not found' });
  res.json(publicAssetResponse(asset));
});

app.post('/api/assets', requireAuth, (req, res) => {
  const body = req.body || {};
  const hostname = cleanText(body.hostname);
  const assetType = cleanText(body.asset_type) || 'other';
  if (!hostname) return res.status(400).json({ error: '资产名称不能为空' });
  if (!ASSET_TYPES.has(assetType)) return res.status(400).json({ error: '资产类型不受支持' });
  if (assetType === 'computer') {
    return res.status(400).json({ error: '电脑类资产请通过 Agent 自动上报' });
  }
  if (db.prepare('SELECT id FROM assets WHERE hostname=?').get(hostname)) {
    return res.status(409).json({ error: '资产名称已存在' });
  }

  let ip;
  try { ip = normalizeIp(body.ip) ?? null; }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const pingEnabled = body.ping_enabled === false ? 0 : (ip ? 1 : 0);
  const id = uuidv4();
  db.prepare(`
    INSERT INTO assets (
      id,hostname,asset_type,source,manufacturer,model,serial_number,ip,mac_address,
      location,department,owner,asset_tag,notes,ping_enabled,ping_status
    ) VALUES (?,?,?,'manual',?,?,?,?,?,?,?,?,?,?,?,'unknown')
  `).run(
    id, hostname, assetType, cleanText(body.manufacturer) ?? null, cleanText(body.model) ?? null,
    cleanText(body.serial_number) ?? null, ip, cleanText(body.mac_address) ?? null,
    cleanText(body.location) ?? null, cleanText(body.department) ?? null,
    cleanText(body.owner) ?? null, cleanText(body.asset_tag) ?? null,
    cleanText(body.notes) ?? null, pingEnabled
  );
  res.status(201).json(assetResponse(db.prepare('SELECT * FROM assets WHERE id=?').get(id)));
});

app.patch('/api/assets/:id', requireAuth, (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset not found' });
  const body = req.body || {};
  if (asset.source !== 'manual' && ['asset_type', 'ip', 'mac_address', 'ping_enabled']
    .some(field => body[field] !== undefined)) {
    return res.status(400).json({ error: 'Agent 管理的字段不能手工修改' });
  }
  if (body.hostname !== undefined) {
    const hostname = cleanText(body.hostname);
    if (hostname) {
      const duplicate = db.prepare('SELECT id FROM assets WHERE hostname=? AND id<>?')
        .get(hostname, req.params.id);
      if (duplicate) return res.status(409).json({ error: '资产名称已存在' });
    }
  }
  const textFields = [
    'hostname', 'manufacturer', 'model', 'serial_number', 'mac_address',
    'location', 'department', 'owner', 'asset_tag', 'notes'
  ];
  const updates = [];
  const values = [];

  for (const field of textFields) {
    if (body[field] !== undefined) {
      const value = cleanText(body[field]);
      if (field === 'hostname' && !value) return res.status(400).json({ error: '资产名称不能为空' });
      updates.push(`${field}=?`);
      values.push(value);
    }
  }
  if (body.asset_type !== undefined) {
    const assetType = cleanText(body.asset_type);
    if (!ASSET_TYPES.has(assetType)) return res.status(400).json({ error: '资产类型不受支持' });
    if (assetType === 'computer') {
      return res.status(400).json({ error: '电脑类资产请通过 Agent 自动上报' });
    }
    updates.push('asset_type=?');
    values.push(assetType);
  }
  if (body.ip !== undefined) {
    try {
      updates.push('ip=?', "ping_status='unknown'", 'last_ping_at=NULL', 'ping_latency_ms=NULL');
      values.push(normalizeIp(body.ip));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  if (body.ping_enabled !== undefined) {
    updates.push('ping_enabled=?');
    values.push(body.ping_enabled ? 1 : 0);
  }
  if (updates.length) {
    values.push(req.params.id);
    try {
      db.prepare(`UPDATE assets SET ${updates.join(',')} WHERE id=?`).run(...values);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '资产名称已存在' });
      throw error;
    }
  }
  res.json(assetResponse(db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id)));
});

app.post('/api/assets/:id/ping', requireAuth, async (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'asset not found' });
  if (asset.source !== 'manual') {
    return res.status(400).json({ error: 'Agent 资产使用上报时间判断在线状态' });
  }
  try {
    res.json(await checkAssetPing(asset));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/assets/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM assets WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'asset not found' });
  res.json({ ok: true, deleted: result.changes });
});

app.get('/api/assets/:id/vnc', requireAuth, (req, res) => {
  const a = db.prepare('SELECT ip,vnc_port FROM assets WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({ vnc_url: `vnc://${a.ip}:${a.vnc_port||5900}` });
});

// ── QR Code ───────────────────────────────────────────────────────────────────
app.get('/api/assets/:id/qr', async (req, res) => {
  const a = db.prepare('SELECT id,hostname FROM assets WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const requestBaseUrl = `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`;
  const url = `${PUBLIC_BASE_URL || requestBaseUrl}/asset?id=${encodeURIComponent(a.id)}`;
  try {
    const png = await QRCode.toBuffer(url, { width: 300, margin: 2, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ── Inventory Sessions ────────────────────────────────────────────────────────
app.get('/api/inventory', requireAuth, (req, res) => {
  const sessions = db.prepare('SELECT * FROM inventory_sessions ORDER BY created_at DESC').all();
  sessions.forEach(s => {
    s.total = db.prepare('SELECT COUNT(*) as c FROM inventory_records WHERE session_id=?').get(s.id).c;
  });
  res.json(sessions);
});

app.post('/api/inventory', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  db.prepare('INSERT INTO inventory_sessions (id,name,created_by) VALUES (?,?,?)')
    .run(id, name, req.user?.sub || 'admin');
  res.json({ id });
});

app.patch('/api/inventory/:id/close', requireAuth, (req, res) => {
  const session = db.prepare('SELECT status,closed_at FROM inventory_sessions WHERE id=?')
    .get(req.params.id);
  if (!session) return res.status(404).json({ error: 'inventory session not found' });
  if (session.status === 'closed') {
    return res.json({ ok: true, already_closed: true, closed_at: session.closed_at });
  }
  const result = db.prepare("UPDATE inventory_sessions SET status='closed',closed_at=datetime('now') WHERE id=? AND status='open'")
    .run(req.params.id);
  if (result.changes === 0) return res.status(409).json({ error: '盘点状态已变化，请刷新后重试' });
  const closed = db.prepare('SELECT closed_at FROM inventory_sessions WHERE id=?').get(req.params.id);
  res.json({ ok: true, already_closed: false, closed_at: closed.closed_at });
});

app.delete('/api/inventory/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM inventory_records WHERE session_id=?').run(req.params.id);
  db.prepare('DELETE FROM inventory_sessions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Records within a session
app.get('/api/inventory/:id/records', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, a.hostname, a.ip, a.platform, a.location as asset_location,
           a.department, a.owner, a.asset_type, a.asset_tag
    FROM inventory_records r
    JOIN assets a ON a.id = r.asset_id
    WHERE r.session_id=? ORDER BY r.scanned_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// Scan / check-in an asset into a session (used by both QR scan page and manual click)
app.post('/api/inventory/:id/scan', (req, res) => {
  // scan endpoint is auth-light: accept JWT or a one-time scan token (future)
  const h = req.headers.authorization || '';
  let authed = false;
  if (h === `Bearer agent:${AGENT_SECRET}`) authed = true;
  if (!authed) {
    try { jwt.verify(h.slice(7), JWT_SECRET); authed = true; } catch {}
  }
  // Also allow unauthenticated scan from mobile (open link from QR)
  authed = true; // QR links are public-readable; recording is the auth action

  const { asset_id, scanned_location, note, scanned_by } = req.body || {};
  if (!asset_id) return res.status(400).json({ error: 'asset_id required' });
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.status === 'closed') return res.status(400).json({ error: '盘点已关闭' });
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(asset_id);
  if (!asset) return res.status(404).json({ error: 'asset not found' });

  // Update asset location if provided
  if (scanned_location) {
    db.prepare('UPDATE assets SET location=? WHERE id=?').run(scanned_location, asset_id);
  }

  // Upsert record (one asset once per session)
  const existing = db.prepare('SELECT id FROM inventory_records WHERE session_id=? AND asset_id=?')
    .get(req.params.id, asset_id);
  if (existing) {
    db.prepare('UPDATE inventory_records SET scanned_location=?,note=?,scanned_by=?,scanned_at=datetime("now") WHERE id=?')
      .run(scanned_location||null, note||null, scanned_by||null, existing.id);
  } else {
    db.prepare('INSERT INTO inventory_records (session_id,asset_id,scanned_location,note,scanned_by) VALUES (?,?,?,?,?)')
      .run(req.params.id, asset_id, scanned_location||null, note||null, scanned_by||null);
  }
  res.json({ ok: true, hostname: asset.hostname });
});

// ── Reports / CSV Export ──────────────────────────────────────────────────────
function toCSV(rows, cols) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
}

// All assets report
app.get('/api/reports/assets.csv', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM assets ORDER BY hostname').all();
  const cols = ['hostname','asset_type','source','manufacturer','model','serial_number',
    'platform','ip','mac_address','cpu','cpu_cores','ram_total','disk_total','os','os_version',
    'location','department','owner','asset_tag','ping_enabled','ping_status','last_ping_at',
    'ping_latency_ms','last_seen','created_at'];
  res.set('Content-Type','text/csv; charset=utf-8');
  res.set('Content-Disposition','attachment; filename="assets.csv"');
  res.set('Cache-Control','no-store');
  res.send('\uFEFF' + toCSV(rows, cols));
});

// Inventory session report
app.get('/api/reports/inventory/:id.csv', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const rows = db.prepare(`
    SELECT a.hostname, a.asset_type, a.asset_tag, a.department, a.owner, a.ip, a.platform, a.os,
           r.scanned_location, r.note, r.scanned_by, r.scanned_at,
           a.location as registered_location
    FROM inventory_records r JOIN assets a ON a.id=r.asset_id
    WHERE r.session_id=? ORDER BY r.scanned_at
  `).all(req.params.id);

  // Append un-scanned assets
  const scannedIds = new Set(rows.map(r => r.hostname));
  const all = db.prepare('SELECT hostname,asset_type,asset_tag,department,owner,ip,platform,os,location FROM assets').all();
  for (const a of all) {
    if (!scannedIds.has(a.hostname)) {
      rows.push({ ...a, registered_location: a.location,
        scanned_location:'', note:'未盘点', scanned_by:'', scanned_at:'' });
    }
  }
  const cols = ['hostname','asset_type','asset_tag','department','owner','ip','platform','os',
    'registered_location','scanned_location','note','scanned_by','scanned_at'];
  res.set('Content-Type','text/csv; charset=utf-8');
  res.set('Cache-Control','no-store');
  const fn = encodeURIComponent(`inventory-${session.name}.csv`);
  res.set('Content-Disposition',`attachment; filename="inventory.csv"; filename*=UTF-8''${fn}`);
  res.send('\uFEFF' + toCSV(rows, cols));
});

// Inventory summary stats
app.get('/api/inventory/:id/stats', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const total = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
  const scanned = db.prepare('SELECT COUNT(*) as c FROM inventory_records WHERE session_id=?').get(req.params.id).c;
  res.json({ total, scanned, missing: total - scanned, session });
});

app.get('/api/public/inventory/:id', (req, res) => {
  const session = db.prepare('SELECT id,name,status FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: '盘点场次不存在' });
  const assets = db.prepare(`
    SELECT id,hostname,asset_type,ip,location,department,owner,asset_tag
    FROM assets ORDER BY hostname
  `).all();
  const scanned = db.prepare('SELECT COUNT(*) as c FROM inventory_records WHERE session_id=?')
    .get(req.params.id).c;
  res.json({ session, assets, stats: {
    total: assets.length,
    scanned,
    missing: assets.length - scanned
  } });
});

let pingSweepRunning = false;
async function runPingSweep() {
  if (pingSweepRunning) return;
  pingSweepRunning = true;
  try {
    const assets = db.prepare(`
      SELECT * FROM assets
      WHERE source='manual' AND ping_enabled=1 AND ip IS NOT NULL AND ip<>''
      ORDER BY hostname
    `).all();
    for (const asset of assets) {
      try { await checkAssetPing(asset); }
      catch (error) { console.warn(`Ping skipped for ${asset.hostname}: ${error.message}`); }
    }
  } finally {
    pingSweepRunning = false;
  }
}

// SPA fallback
app.get('/asset', (req, res) => res.sendFile(path.join(__dirname, '../frontend/qr.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, '../frontend/scan.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`IT Asset Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Admin user: ${ADMIN_USER}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Ping interval: ${PING_INTERVAL_SECONDS}s`);
});

const initialPingTimer = setTimeout(() => runPingSweep().catch(console.error), 1500);
initialPingTimer.unref();
const pingTimer = setInterval(() => runPingSweep().catch(console.error), PING_INTERVAL_SECONDS * 1000);
pingTimer.unref();

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  clearTimeout(initialPingTimer);
  clearInterval(pingTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
