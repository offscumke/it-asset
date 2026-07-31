const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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
    asset_tag TEXT,
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

// Migrate: add columns if not exists (safe to run multiple times)
['location TEXT','department TEXT','asset_tag TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE assets ADD COLUMN ${col}`); } catch {}
});

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
      ram_total,ram_free,disk_total,disk_free,os,os_version,vnc_port,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      platform=excluded.platform,ip=excluded.ip,mac_address=excluded.mac_address,
      cpu=excluded.cpu,cpu_cores=excluded.cpu_cores,ram_total=excluded.ram_total,
      ram_free=excluded.ram_free,disk_total=excluded.disk_total,disk_free=excluded.disk_free,
      os=excluded.os,os_version=excluded.os_version,vnc_port=excluded.vnc_port,
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
  res.json(db.prepare('SELECT * FROM assets ORDER BY last_seen DESC').all());
});

app.get('/api/assets/:id', requireAuth, (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'not found' });
  asset.software = db.prepare('SELECT name,version FROM software WHERE asset_id=? ORDER BY name').all(asset.id);
  res.json(asset);
});

app.patch('/api/assets/:id', requireAuth, (req, res) => {
  const { location, department, asset_tag } = req.body || {};
  db.prepare(`UPDATE assets SET location=COALESCE(?,location), department=COALESCE(?,department),
    asset_tag=COALESCE(?,asset_tag) WHERE id=?`)
    .run(location ?? null, department ?? null, asset_tag ?? null, req.params.id);
  res.json({ ok: true });
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
app.get('/api/assets/:id/qr', requireAuth, async (req, res) => {
  const a = db.prepare('SELECT id,hostname FROM assets WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const requestBaseUrl = `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`;
  const url = `${PUBLIC_BASE_URL || requestBaseUrl}/scan?id=${a.id}`;
  const png = await QRCode.toBuffer(url, { width: 300, margin: 2 });
  res.set('Content-Type', 'image/png');
  res.send(png);
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
           a.department, a.asset_tag
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
  const cols = ['hostname','platform','ip','mac_address','cpu','cpu_cores',
    'ram_total','disk_total','os','os_version','location','department','asset_tag','last_seen','created_at'];
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
    SELECT a.hostname, a.asset_tag, a.department, a.ip, a.platform, a.os,
           r.scanned_location, r.note, r.scanned_by, r.scanned_at,
           a.location as registered_location
    FROM inventory_records r JOIN assets a ON a.id=r.asset_id
    WHERE r.session_id=? ORDER BY r.scanned_at
  `).all(req.params.id);

  // Append un-scanned assets
  const scannedIds = new Set(rows.map(r => r.hostname));
  const all = db.prepare('SELECT hostname,asset_tag,department,ip,platform,os,location FROM assets').all();
  for (const a of all) {
    if (!scannedIds.has(a.hostname)) {
      rows.push({ ...a, registered_location: a.location,
        scanned_location:'', note:'未盘点', scanned_by:'', scanned_at:'' });
    }
  }
  const cols = ['hostname','asset_tag','department','ip','platform','os',
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

// SPA fallback
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, '../frontend/scan.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`IT Asset Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Admin user: ${ADMIN_USER}`);
  console.log(`Database: ${DB_PATH}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
