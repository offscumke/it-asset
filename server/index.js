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
const multer = require('multer');

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
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads'));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const PING_INTERVAL_SECONDS = Math.max(15, Number(process.env.PING_INTERVAL_SECONDS) || 60);
const PING_TIMEOUT_MS = 4000;
const ASSET_TYPES = new Set([
  'computer', 'server', 'switch', 'firewall', 'router',
  'wireless_ap', 'printer', 'storage', 'other'
]);
const LIFECYCLE_LABELS = {
  planned: '采购中',
  procured: '已采购',
  in_stock: '库存',
  in_use: '在用',
  spare: '备用',
  repair: '维修',
  loaned: '借出',
  transferred: '调拨中',
  retired: '已报废',
  recycled: '已回收',
  suspended: '已停用',
  lost: '丢失'
};
const LIFECYCLE_STATES = new Set(Object.keys(LIFECYCLE_LABELS));
const ASSET_FIELD_LABELS = {
  hostname: '资产名称',
  asset_type: '资产类型',
  manufacturer: '厂商',
  model: '型号',
  serial_number: '序列号',
  ip: 'IP 地址',
  mac_address: 'MAC 地址',
  location: '位置',
  department: '部门',
  owner: '责任人',
  asset_tag: '资产标签',
  notes: '备注',
  ping_enabled: 'Ping 监测',
  lifecycle_status: '生命周期状态',
  purchase_date: '采购日期',
  purchase_cost: '采购成本',
  warranty_expires_at: '保修到期',
  supplier: '供应商',
  owner_user_id: '责任用户'
};

const ROLE_LABELS = {
  admin: '系统管理员',
  asset_manager: '资产管理员',
  auditor: '审计员',
  employee: '普通员工'
};
const ROLE_PERMISSIONS = {
  admin: new Set(['*']),
  asset_manager: new Set([
    'asset:read', 'asset:write', 'asset:delete', 'lifecycle:read', 'lifecycle:write',
    'inventory:read', 'inventory:write', 'work:read', 'work:write', 'report:read',
    'notification:read', 'attachment:read', 'attachment:write', 'integration:read', 'audit:read'
  ]),
  auditor: new Set(['asset:read', 'lifecycle:read', 'inventory:read', 'work:read', 'report:read', 'audit:read', 'notification:read', 'attachment:read']),
  employee: new Set(['asset:read', 'asset:self', 'lifecycle:request', 'work:read', 'work:write', 'notification:read', 'attachment:read', 'attachment:write'])
};
const TRANSACTION_TYPES = new Set([
  'purchase', 'stock_in', 'assign', 'return', 'loan', 'loan_return', 'repair',
  'repair_complete', 'transfer', 'retire', 'recycle', 'disable', 'enable'
]);
const TRANSACTION_LABELS = {
  purchase: '采购', stock_in: '入库', assign: '领用', return: '归还', loan: '借用',
  loan_return: '借用归还', repair: '送修', repair_complete: '维修完成', transfer: '调拨',
  retire: '报废', recycle: '回收', disable: '停用', enable: '启用'
};

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) => callback(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set([
      'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
      'text/plain', 'text/csv', 'application/zip',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]);
    callback(null, allowed.has(file.mimetype));
  }
});

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
    owner_user_id TEXT,
    asset_tag TEXT,
    asset_type TEXT DEFAULT 'computer',
    source TEXT DEFAULT 'agent',
    manufacturer TEXT,
    model TEXT,
    serial_number TEXT,
    notes TEXT,
    purchase_date TEXT,
    purchase_cost REAL DEFAULT 0,
    currency TEXT DEFAULT 'CNY',
    warranty_expires_at TEXT,
    supplier TEXT,
    invoice_no TEXT,
    useful_life_months INTEGER,
    residual_value REAL DEFAULT 0,
    retired_at TEXT,
    retired_reason TEXT,
    lifecycle_status TEXT DEFAULT 'in_use',
    lifecycle_updated_at TEXT DEFAULT (datetime('now')),
    ping_enabled INTEGER DEFAULT 0,
    ping_status TEXT DEFAULT 'unknown',
    last_ping_at TEXT,
    ping_latency_ms REAL,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
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
    scan_token TEXT,
    scope_type TEXT DEFAULT 'all',
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
  CREATE TABLE IF NOT EXISTS asset_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'employee',
    department TEXT,
    email TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT,
    actor_username TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    summary TEXT,
    metadata TEXT,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS asset_transactions (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by TEXT,
    approved_by TEXT,
    to_owner_user_id TEXT,
    to_department TEXT,
    to_location TEXT,
    due_at TEXT,
    amount REAL,
    notes TEXT,
    decision_note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    decided_at TEXT,
    completed_at TEXT,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS work_orders (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    asset_id TEXT,
    type TEXT NOT NULL DEFAULT 'request',
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open',
    requester_user_id TEXT,
    assignee_user_id TEXT,
    due_at TEXT,
    resolved_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS work_order_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id TEXT NOT NULL,
    author_user_id TEXT,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    type TEXT NOT NULL DEFAULT 'info',
    entity_type TEXT,
    entity_id TEXT,
    dedupe_key TEXT UNIQUE,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS inventory_expected (
    session_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    expected_location TEXT,
    expected_owner TEXT,
    expected_status TEXT,
    PRIMARY KEY(session_id, asset_id),
    FOREIGN KEY(session_id) REFERENCES inventory_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS inventory_resolutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    difference_type TEXT NOT NULL,
    resolution TEXT NOT NULL,
    note TEXT,
    resolved_by TEXT,
    resolved_at TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, asset_id, difference_type),
    FOREIGN KEY(session_id) REFERENCES inventory_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS asset_relations (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    related_asset_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(asset_id, related_asset_id, relation_type),
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY(related_asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    endpoint TEXT,
    secret_ref TEXT,
    config_json TEXT,
    notes TEXT,
    last_sync_at TEXT,
    last_status TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS integration_runs (
    id TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    records_seen INTEGER DEFAULT 0,
    records_created INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    FOREIGN KEY(integration_id) REFERENCES integrations(id) ON DELETE CASCADE
  );
`);

// Additive migration keeps databases created by earlier releases usable.
const assetColumns = {
  location: 'TEXT',
  department: 'TEXT',
  owner: 'TEXT',
  owner_user_id: 'TEXT',
  asset_tag: 'TEXT',
  asset_type: "TEXT DEFAULT 'computer'",
  source: "TEXT DEFAULT 'agent'",
  manufacturer: 'TEXT',
  model: 'TEXT',
  serial_number: 'TEXT',
  notes: 'TEXT',
  purchase_date: 'TEXT',
  purchase_cost: 'REAL DEFAULT 0',
  currency: "TEXT DEFAULT 'CNY'",
  warranty_expires_at: 'TEXT',
  supplier: 'TEXT',
  invoice_no: 'TEXT',
  useful_life_months: 'INTEGER',
  residual_value: 'REAL DEFAULT 0',
  retired_at: 'TEXT',
  retired_reason: 'TEXT',
  lifecycle_status: "TEXT DEFAULT 'in_use'",
  // SQLite only permits constant defaults when adding a column to an existing table.
  lifecycle_updated_at: 'TEXT',
  ping_enabled: 'INTEGER DEFAULT 0',
  ping_status: "TEXT DEFAULT 'unknown'",
  last_ping_at: 'TEXT',
  ping_latency_ms: 'REAL',
  updated_at: 'TEXT'
};
const existingAssetColumns = new Set(
  db.prepare('PRAGMA table_info(assets)').all().map(column => column.name)
);
for (const [name, definition] of Object.entries(assetColumns)) {
  if (!existingAssetColumns.has(name)) db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${definition}`);
}
const inventoryColumns = {
  scan_token: 'TEXT',
  scope_type: "TEXT DEFAULT 'all'"
};
const existingInventoryColumns = new Set(
  db.prepare('PRAGMA table_info(inventory_sessions)').all().map(column => column.name)
);
for (const [name, definition] of Object.entries(inventoryColumns)) {
  if (!existingInventoryColumns.has(name)) db.exec(`ALTER TABLE inventory_sessions ADD COLUMN ${name} ${definition}`);
}
const integrationColumns = {
  notes: 'TEXT'
};
const existingIntegrationColumns = new Set(
  db.prepare('PRAGMA table_info(integrations)').all().map(column => column.name)
);
for (const [name, definition] of Object.entries(integrationColumns)) {
  if (!existingIntegrationColumns.has(name)) db.exec(`ALTER TABLE integrations ADD COLUMN ${name} ${definition}`);
}
const userColumns = {
  notes: 'TEXT'
};
const existingUserColumns = new Set(
  db.prepare('PRAGMA table_info(users)').all().map(column => column.name)
);
for (const [name, definition] of Object.entries(userColumns)) {
  if (!existingUserColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}
db.exec(`
  UPDATE assets SET asset_type='computer' WHERE asset_type IS NULL OR asset_type='';
  UPDATE assets SET source='agent' WHERE source IS NULL OR source='';
  UPDATE assets SET lifecycle_status='in_use' WHERE lifecycle_status IS NULL OR lifecycle_status='';
  UPDATE assets SET lifecycle_updated_at=COALESCE(lifecycle_updated_at, created_at, datetime('now'))
    WHERE lifecycle_updated_at IS NULL OR lifecycle_updated_at='';
  UPDATE assets SET ping_enabled=0 WHERE ping_enabled IS NULL;
  UPDATE assets SET ping_status='unknown' WHERE ping_status IS NULL OR ping_status='';
  UPDATE assets SET purchase_cost=0 WHERE purchase_cost IS NULL;
  UPDATE assets SET residual_value=0 WHERE residual_value IS NULL;
  UPDATE assets SET updated_at=COALESCE(updated_at, created_at, datetime('now'))
    WHERE updated_at IS NULL OR updated_at='';
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_agent_serial
  ON assets(lower(trim(serial_number)))
  WHERE source='agent' AND serial_number IS NOT NULL AND trim(serial_number)<>'';
  CREATE INDEX IF NOT EXISTS idx_asset_events_asset_created
  ON asset_events(asset_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_asset_created ON asset_transactions(asset_id, created_at DESC);
`);

const validRoles = new Set(Object.keys(ROLE_LABELS));
const existingAdmin = db.prepare('SELECT id FROM users WHERE username=?').get(ADMIN_USER);
if (!existingAdmin) {
  db.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,active)
    VALUES (?,?,?,?,?,1)`).run(uuidv4(), ADMIN_USER, ADMIN_USER, ADMIN_PASS_HASH, 'admin');
}

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

function normalizeMac(value) {
  const mac = cleanText(value);
  return mac ? mac.toLowerCase().replace(/[.-]/g, ':') : null;
}

function normalizeSerial(value) {
  const serial = cleanText(value);
  return serial ? serial.toUpperCase() : null;
}

function normalizeMoney(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('金额必须是大于等于 0 的数字');
  return Number(amount.toFixed(2));
}

function normalizeInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error('数值格式不正确');
  return number;
}

function normalizeDate(value) {
  const date = cleanText(value);
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(date)) {
    throw new Error('日期格式应为 YYYY-MM-DD');
  }
  return date;
}

function normalizeLifecycleStatus(value) {
  const status = cleanText(value);
  if (!status) return 'in_use';
  if (!LIFECYCLE_STATES.has(status)) throw new Error('资产状态不受支持');
  return status;
}

function lifecycleLabel(status) {
  return LIFECYCLE_LABELS[status] || LIFECYCLE_LABELS.in_use;
}

function preferredAgentHostname(existing, incoming) {
  if (existing?.hostname && net.isIP(incoming) && !net.isIP(existing.hostname)) {
    return existing.hostname;
  }
  return incoming;
}

function formatAssetValue(field, value) {
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'ping_enabled') return value ? '开启' : '关闭';
  if (field === 'lifecycle_status') return lifecycleLabel(value);
  if (field === 'asset_type') {
    return {
      computer: '电脑',
      server: '服务器',
      switch: '交换机',
      firewall: '防火墙',
      router: '路由器',
      wireless_ap: '无线 AP',
      printer: '打印机',
      storage: '存储',
      other: '其他'
    }[value] || value;
  }
  return String(value);
}

function summarizeAssetChanges(before, after, fields) {
  const changes = [];
  for (const field of fields) {
    const previous = formatAssetValue(field, before?.[field]);
    const next = formatAssetValue(field, after?.[field]);
    if (previous !== next) {
      changes.push(`${ASSET_FIELD_LABELS[field] || field}：${previous} → ${next}`);
    }
  }
  return changes.join('；');
}

function recordAssetEvent(assetId, action, actor, detail) {
  db.prepare('INSERT INTO asset_events (asset_id,action,actor,detail) VALUES (?,?,?,?)')
    .run(assetId, action, actor || null, detail || null);
}

function audit(req, action, entityType, entityId, summary, metadata) {
  db.prepare(`INSERT INTO audit_logs
    (actor_user_id,actor_username,action,entity_type,entity_id,summary,metadata,ip)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    req?.user?.id || null, req?.user?.username || req?.user?.sub || null,
    action, entityType, entityId || null, summary || null,
    metadata ? JSON.stringify(metadata) : null, req?.ip || null
  );
}

function userResponse(user) {
  if (!user) return null;
  return {
    id: user.id, username: user.username, display_name: user.display_name,
    role: user.role, role_label: ROLE_LABELS[user.role] || user.role,
    department: user.department || null, email: user.email || null,
    notes: user.notes || null,
    active: Boolean(user.active), created_at: user.created_at,
    last_login_at: user.last_login_at || null
  };
}

function permissionsFor(user) {
  return [...(ROLE_PERMISSIONS[user?.role] || new Set())];
}

function hasPermission(user, permission) {
  const permissions = ROLE_PERMISSIONS[user?.role];
  return Boolean(permissions && (permissions.has('*') || permissions.has(permission)));
}

function bookValue(asset, asOf = new Date()) {
  const cost = Number(asset?.purchase_cost || 0);
  const residual = Math.max(0, Number(asset?.residual_value || 0));
  const months = Number(asset?.useful_life_months || 0);
  if (!cost || !months || !asset?.purchase_date) return cost || 0;
  const start = new Date(`${asset.purchase_date}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return cost;
  const elapsed = Math.max(0, Math.floor((asOf.getTime() - start.getTime()) / (30.4375 * 86400000)));
  const monthly = Math.max(0, (cost - residual) / months);
  return Math.max(residual, Number((cost - monthly * elapsed).toFixed(2)));
}

function createNotification(userId, title, body, type, entityType, entityId, dedupeKey) {
  if (!userId) return;
  try {
    db.prepare(`INSERT INTO notifications
      (id,user_id,title,body,type,entity_type,entity_id,dedupe_key)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      uuidv4(), userId, title, body || null, type || 'info', entityType || null,
      entityId || null, dedupeKey || null
    );
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) throw error;
  }
}

function notifyRole(role, title, body, type, entityType, entityId, keyPrefix) {
  const users = db.prepare('SELECT id FROM users WHERE role=? AND active=1').all(role);
  users.forEach(user => createNotification(user.id, title, body, type, entityType, entityId,
    keyPrefix ? `${keyPrefix}:${user.id}` : null));
}

function transitionForTransaction(type) {
  return {
    purchase: 'procured', stock_in: 'in_stock', assign: 'in_use', return: 'in_stock',
    loan: 'loaned', loan_return: 'in_stock', repair: 'repair', repair_complete: 'in_use',
    transfer: 'transferred', retire: 'retired', recycle: 'recycled', disable: 'suspended',
    enable: 'in_use'
  }[type];
}

function summarizeTransaction(transaction) {
  const label = TRANSACTION_LABELS[transaction.type] || transaction.type;
  return [label, transaction.to_department ? `部门：${transaction.to_department}` : '',
    transaction.to_location ? `位置：${transaction.to_location}` : '',
    transaction.amount != null ? `金额：${transaction.amount}` : '',
    transaction.notes ? `备注：${transaction.notes}` : ''].filter(Boolean).join(' · ');
}

function assetScopedToUser(asset, user) {
  if (user?.role !== 'employee') return true;
  return asset.owner_user_id === user.id || asset.owner === user.display_name || asset.owner === user.username;
}

function assetResponse(asset) {
  if (!asset) return asset;
  return { ...asset, online_status: assetOnlineStatus(asset), book_value: bookValue(asset) };
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

function publicAssetResponse(asset) {
  const row = assetResponse(asset);
  if (!row) return row;
  const fields = [
    'id', 'hostname', 'asset_type', 'source', 'manufacturer', 'model',
    'serial_number', 'ip', 'mac_address', 'location', 'department', 'owner',
    'owner_user_id', 'asset_tag', 'notes', 'lifecycle_status', 'lifecycle_updated_at',
    'purchase_date', 'currency', 'warranty_expires_at', 'supplier',
    'online_status', 'last_seen', 'last_ping_at', 'ping_latency_ms'
  ];
  return Object.fromEntries(fields.map(field => [field, (field === 'book_value' ? row.book_value : row[field]) ?? null]));
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
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=? OR username=?').get(payload.sub, payload.username || payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: '账号已停用' });
    req.user = { ...user, sub: user.username, permissions: permissionsFor(user) };
    next();
  } catch { res.status(401).json({ error: 'invalid token' }); }
}
function requireAgentOrAuth(req, res, next) {
  if ((req.headers.authorization || '') === `Bearer agent:${AGENT_SECRET}`) return next();
  requireAuth(req, res, next);
}
function requirePermission(permission) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!hasPermission(req.user, permission)) return res.status(403).json({ error: '没有执行此操作的权限' });
      next();
    });
  };
}
function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!permissions.some(permission => hasPermission(req.user, permission))) {
        return res.status(403).json({ error: '没有执行此操作的权限' });
      }
      next();
    });
  };
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(cleanText(username));
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: '用户名或密码错误' });
  db.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").run(user.id);
  const token = jwt.sign({ sub: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: userResponse(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: userResponse(req.user), permissions: permissionsFor(req.user) });
});

app.get('/api/users/directory', requirePermission('asset:read'), (req, res) => {
  const users = db.prepare(`SELECT id,username,display_name,role,department,email,active
    FROM users WHERE active=1 ORDER BY display_name,username`).all();
  res.json(users.map(userResponse));
});

app.get('/api/users', requirePermission('user:manage'), (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY active DESC, display_name, username')
    .all().map(userResponse));
});

app.post('/api/users', requirePermission('user:manage'), (req, res) => {
  const body = req.body || {};
  const username = cleanText(body.username);
  const displayName = cleanText(body.display_name) || username;
  const password = String(body.password || '');
  const role = cleanText(body.role) || 'employee';
  if (!username || !/^[a-zA-Z0-9._-]{2,64}$/.test(username)) {
    return res.status(400).json({ error: '用户名需为 2-64 位字母、数字、点、下划线或短横线' });
  }
  if (password.length < 8) return res.status(400).json({ error: '密码至少需要 8 位' });
  if (!validRoles.has(role)) return res.status(400).json({ error: '用户角色不受支持' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) {
    return res.status(409).json({ error: '用户名已存在' });
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,department,email,notes,active)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, username, displayName, bcrypt.hashSync(password, 10), role,
    cleanText(body.department) || null, cleanText(body.email) || null,
    cleanText(body.notes) || null, body.active === false ? 0 : 1
  );
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  audit(req, 'user.create', 'user', id, `创建用户：${username}`, { role });
  res.status(201).json(userResponse(user));
});

app.patch('/api/users/:id', requirePermission('user:manage'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const body = req.body || {};
  const updates = [];
  const values = [];
  for (const field of ['display_name', 'department', 'email', 'notes']) {
    if (body[field] !== undefined) { updates.push(`${field}=?`); values.push(cleanText(body[field])); }
  }
  if (body.role !== undefined) {
    if (!validRoles.has(body.role)) return res.status(400).json({ error: '用户角色不受支持' });
    updates.push('role=?'); values.push(body.role);
  }
  if (body.active !== undefined) {
    if (user.id === req.user.id && !body.active) return res.status(400).json({ error: '不能停用当前登录账号' });
    updates.push('active=?'); values.push(body.active ? 1 : 0);
  }
  if (body.password !== undefined) {
    if (String(body.password).length < 8) return res.status(400).json({ error: '密码至少需要 8 位' });
    updates.push('password_hash=?'); values.push(bcrypt.hashSync(String(body.password), 10));
  }
  if (!updates.length) return res.json(userResponse(user));
  values.push(user.id);
  db.prepare(`UPDATE users SET ${updates.join(',')} WHERE id=?`).run(...values);
  const updated = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  audit(req, 'user.update', 'user', user.id, `更新用户：${user.username}`);
  res.json(userResponse(updated));
});

app.delete('/api/users/:id', requirePermission('user:manage'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.id === req.user.id) return res.status(400).json({ error: '不能停用当前登录账号' });
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(user.id);
  audit(req, 'user.deactivate', 'user', user.id, `停用用户：${user.username}`);
  res.json({ ok: true });
});

// ── Agent check-in ────────────────────────────────────────────────────────────
app.post('/api/checkin', requireAgentOrAuth, (req, res) => {
  const d = req.body || {};
  const hostname = cleanText(d.hostname);
  if (!hostname) return res.status(400).json({ error: 'hostname required' });
  const sn = normalizeSerial(d.serial_number);
  const macAddress = normalizeMac(d.mac_address);
  const existingHostname = hostname;
  let existing = sn
    ? db.prepare("SELECT id,hostname,serial_number FROM assets WHERE source='agent' AND lower(trim(serial_number))=lower(trim(?))").get(sn)
    : null;
  if (!existing) {
    existing = macAddress
      ? db.prepare(`
          SELECT id,hostname,serial_number FROM assets
          WHERE source='agent' AND mac_address=?
          ORDER BY CASE WHEN serial_number IS NOT NULL AND serial_number<>'' THEN 1 ELSE 0 END DESC,
                   COALESCE(last_seen,created_at) DESC
          LIMIT 1
        `).get(macAddress)
      : null;
  }
  if (!existing) {
    const byHostname = db.prepare(
      "SELECT id,hostname,serial_number FROM assets WHERE source='agent' AND hostname=?"
    ).get(hostname);
    if (byHostname && (!sn || !byHostname.serial_number || byHostname.serial_number === sn)) {
      existing = byHostname;
    }
  }
  const id = existing ? existing.id : uuidv4();
  db.prepare(`
    INSERT INTO assets (id,hostname,platform,ip,mac_address,cpu,cpu_cores,
      ram_total,ram_free,disk_total,disk_free,os,os_version,vnc_port,
      asset_type,source,lifecycle_status,lifecycle_updated_at,ping_enabled,ping_status,
      last_seen,serial_number,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'computer','agent','in_use',datetime('now'),0,'unknown',datetime('now'),?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      hostname=excluded.hostname,platform=excluded.platform,ip=excluded.ip,
      mac_address=COALESCE(excluded.mac_address,assets.mac_address),
      cpu=excluded.cpu,cpu_cores=excluded.cpu_cores,ram_total=excluded.ram_total,
      ram_free=excluded.ram_free,disk_total=excluded.disk_total,disk_free=excluded.disk_free,
      os=excluded.os,vnc_port=excluded.vnc_port,os_version=excluded.os_version,
      asset_type='computer',source='agent',ping_enabled=0,ping_status='unknown',
      last_seen=datetime('now'),
      serial_number=COALESCE(NULLIF(excluded.serial_number,''),assets.serial_number),
      updated_at=datetime('now')
  `).run(id,preferredAgentHostname(existing, hostname),d.platform||null,d.ip||null,macAddress,
    d.cpu||null,d.cpu_cores||null,d.ram_total||null,d.ram_free||null,
    d.disk_total||null,d.disk_free||null,d.os||null,d.os_version||null,d.vnc_port||5900,sn);
  const savedAsset = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
  if (Array.isArray(d.software)) {
    db.prepare('DELETE FROM software WHERE asset_id=?').run(id);
    const ins = db.prepare('INSERT INTO software (asset_id,name,version) VALUES (?,?,?)');
    for (const s of d.software) ins.run(id, s.name, s.version || '');
  }
  if (!existing) {
    recordAssetEvent(id, 'agent_create', 'agent',
      `首次上报：${savedAsset.hostname}${sn ? ` / SN ${sn}` : ''}`);
    db.prepare(`INSERT INTO audit_logs (actor_username,action,entity_type,entity_id,summary)
      VALUES ('agent','asset.checkin','asset',?,?)`).run(id, `Agent 首次上报：${savedAsset.hostname}`);
  } else if (existing.hostname !== existingHostname) {
    recordAssetEvent(id, 'agent_rename', 'agent',
      summarizeAssetChanges(existing, savedAsset, ['hostname']));
    db.prepare(`INSERT INTO audit_logs (actor_username,action,entity_type,entity_id,summary)
      VALUES ('agent','asset.rename','asset',?,?)`).run(id, `Agent 主机名变更：${existing.hostname} → ${savedAsset.hostname}`);
  }
  res.json({ id });
});

// ── Assets CRUD ───────────────────────────────────────────────────────────────
app.get('/api/assets', requirePermission('asset:read'), (req, res) => {
  const assets = req.user.role === 'employee'
    ? db.prepare(`SELECT * FROM assets
        WHERE owner_user_id=? OR owner=? OR owner=?
        ORDER BY COALESCE(last_seen,last_ping_at,created_at) DESC, hostname`)
      .all(req.user.id, req.user.display_name, req.user.username)
    : db.prepare(`SELECT * FROM assets
        ORDER BY COALESCE(last_seen,last_ping_at,created_at) DESC, hostname`).all();
  res.json(assets.map(assetResponse));
});

app.get('/api/assets/:id', requirePermission('asset:read'), (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'not found' });
  if (!assetScopedToUser(asset, req.user)) return res.status(403).json({ error: '无权查看此资产' });
  asset.software = db.prepare('SELECT name,version FROM software WHERE asset_id=? ORDER BY name').all(asset.id);
  asset.events = db.prepare(`
    SELECT action,actor,detail,created_at
    FROM asset_events
    WHERE asset_id=?
    ORDER BY created_at DESC, id DESC
    LIMIT 8
  `).all(asset.id);
  asset.attachments = db.prepare(`SELECT id,entity_type,entity_id,original_name,mime_type,size_bytes,uploaded_by,created_at
    FROM attachments WHERE entity_type='asset' AND entity_id=? ORDER BY created_at DESC`).all(asset.id);
  asset.relations = db.prepare(`SELECT r.id,r.relation_type,r.related_asset_id,a.hostname,a.asset_type,a.asset_tag
    FROM asset_relations r JOIN assets a ON a.id=r.related_asset_id
    WHERE r.asset_id=? ORDER BY a.hostname`).all(asset.id);
  res.json(assetResponse(asset));
});

app.get('/api/public/assets/:id', (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'not found' });
  res.json(publicAssetResponse(asset));
});

app.post('/api/assets', requirePermission('asset:write'), (req, res) => {
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

  let serialNumber, macAddress, lifecycleStatus, purchaseCost, residualValue;
  let purchaseDate, warrantyExpiresAt, usefulLifeMonths;
  try {
    serialNumber = normalizeSerial(body.serial_number);
    macAddress = normalizeMac(body.mac_address);
    lifecycleStatus = normalizeLifecycleStatus(body.lifecycle_status);
    purchaseCost = normalizeMoney(body.purchase_cost);
    residualValue = normalizeMoney(body.residual_value);
    purchaseDate = normalizeDate(body.purchase_date);
    warrantyExpiresAt = normalizeDate(body.warranty_expires_at);
    usefulLifeMonths = normalizeInteger(body.useful_life_months);
  } catch (error) { return res.status(400).json({ error: error.message }); }
  const ownerUser = body.owner_user_id
    ? db.prepare('SELECT id,display_name,department FROM users WHERE id=? AND active=1').get(body.owner_user_id)
    : null;
  if (body.owner_user_id && !ownerUser) return res.status(400).json({ error: '责任用户不存在或已停用' });
  const pingEnabled = body.ping_enabled === false ? 0 : (ip ? 1 : 0);
  const id = uuidv4();
  db.prepare(`
    INSERT INTO assets (
      id,hostname,asset_type,source,manufacturer,model,serial_number,ip,mac_address,
      location,department,owner,owner_user_id,asset_tag,notes,
      purchase_date,purchase_cost,currency,warranty_expires_at,supplier,invoice_no,
      useful_life_months,residual_value,lifecycle_status,lifecycle_updated_at,
      ping_enabled,ping_status,updated_at
    ) VALUES (?,?,?,'manual',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,'unknown',datetime('now'))
  `).run(
    id, hostname, assetType, cleanText(body.manufacturer) ?? null, cleanText(body.model) ?? null,
    serialNumber, ip, macAddress,
    cleanText(body.location) ?? null, cleanText(body.department) ?? ownerUser?.department ?? null,
    ownerUser?.display_name || cleanText(body.owner) || null, ownerUser?.id || null,
    cleanText(body.asset_tag) ?? null, cleanText(body.notes) ?? null,
    purchaseDate, purchaseCost, cleanText(body.currency) || 'CNY', warrantyExpiresAt,
    cleanText(body.supplier) || null, cleanText(body.invoice_no) || null,
    usefulLifeMonths, residualValue, lifecycleStatus, pingEnabled
  );
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
  recordAssetEvent(id, 'manual_create', req.user?.sub || 'admin',
    `手工录入：${formatAssetValue('asset_type', assetType)} · 状态 ${lifecycleLabel(lifecycleStatus)}`);
  audit(req, 'asset.create', 'asset', id, `创建资产：${hostname}`, { asset_type: assetType });
  res.status(201).json(assetResponse(asset));
});

app.patch('/api/assets/:id', requirePermission('asset:write'), (req, res) => {
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
    'location', 'department', 'owner', 'asset_tag', 'notes', 'currency',
    'supplier', 'invoice_no', 'retired_reason'
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
  if (body.owner_user_id !== undefined) {
    const ownerUser = body.owner_user_id
      ? db.prepare('SELECT id,display_name,department FROM users WHERE id=? AND active=1').get(body.owner_user_id)
      : null;
    if (body.owner_user_id && !ownerUser) return res.status(400).json({ error: '责任用户不存在或已停用' });
    updates.push('owner_user_id=?', 'owner=?');
    values.push(ownerUser?.id || null, ownerUser?.display_name || null);
    if (ownerUser?.department && body.department === undefined) {
      updates.push('department=?'); values.push(ownerUser.department);
    }
  }
  try {
    for (const [field, normalizer] of [
      ['purchase_date', normalizeDate], ['warranty_expires_at', normalizeDate]
    ]) {
      if (body[field] !== undefined) { updates.push(`${field}=?`); values.push(normalizer(body[field])); }
    }
    for (const field of ['purchase_cost', 'residual_value']) {
      if (body[field] !== undefined) { updates.push(`${field}=?`); values.push(normalizeMoney(body[field])); }
    }
    if (body.useful_life_months !== undefined) {
      updates.push('useful_life_months=?'); values.push(normalizeInteger(body.useful_life_months));
    }
  } catch (error) { return res.status(400).json({ error: error.message }); }
  if (body.lifecycle_status !== undefined) {
    const lifecycleStatus = normalizeLifecycleStatus(body.lifecycle_status);
    updates.push('lifecycle_status=?', "lifecycle_updated_at=datetime('now')");
    values.push(lifecycleStatus);
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
    updates.push("updated_at=datetime('now')");
    values.push(req.params.id);
    try {
      db.prepare(`UPDATE assets SET ${updates.join(',')} WHERE id=?`).run(...values);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '资产名称已存在' });
      throw error;
    }
    const updated = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    const summary = summarizeAssetChanges(asset, updated, [
      'hostname', 'asset_type', 'manufacturer', 'model', 'serial_number',
      'ip', 'mac_address', 'location', 'department', 'owner', 'asset_tag',
      'owner_user_id', 'notes', 'purchase_date', 'purchase_cost', 'warranty_expires_at',
      'supplier', 'useful_life_months', 'residual_value', 'ping_enabled', 'lifecycle_status'
    ]);
    if (summary) {
      recordAssetEvent(req.params.id, asset.source === 'manual' ? 'manual_update' : 'asset_update',
        req.user?.sub || 'admin', summary);
      audit(req, 'asset.update', 'asset', req.params.id, summary);
    }
  }
  res.json(assetResponse(db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id)));
});

// ── Bulk Import ───────────────────────────────────────────────────────────────
app.post('/api/assets/bulk', requirePermission('asset:write'), (req, res) => {
  const { assets } = req.body || {};
  if (!Array.isArray(assets) || assets.length === 0) {
    return res.status(400).json({ error: 'assets array required' });
  }
  if (assets.length > 500) {
    return res.status(400).json({ error: '单次最多导入 500 条资产' });
  }

  const results = { created: 0, updated: 0, skipped: [], errors: [] };
  const findByHostname = db.prepare('SELECT id,source FROM assets WHERE hostname=?');
  const findBySerial = db.prepare('SELECT id,source FROM assets WHERE lower(trim(serial_number))=lower(trim(?))');
  const insert = db.prepare(`
    INSERT INTO assets (
      id,hostname,asset_type,source,manufacturer,model,serial_number,ip,mac_address,
      location,department,owner,asset_tag,notes,lifecycle_status,lifecycle_updated_at,
      ping_enabled,ping_status
    ) VALUES (?,?,?,'manual',?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,'unknown')
  `);
  const update = db.prepare(`
    UPDATE assets SET
      hostname=?,asset_type=?,manufacturer=?,model=?,serial_number=?,ip=?,mac_address=?,
      location=?,department=?,owner=?,asset_tag=?,notes=?,lifecycle_status=?,
      lifecycle_updated_at=datetime('now'),ping_enabled=?,
      ping_status='unknown',last_ping_at=NULL,ping_latency_ms=NULL
    WHERE id=?
  `);

  for (const item of assets) {
    try {
      const hostname = cleanText(item?.hostname);
      const assetType = cleanText(item?.asset_type) || 'other';
      if (!hostname) {
        results.skipped.push({ reason: 'missing hostname', item });
        continue;
      }
      if (!ASSET_TYPES.has(assetType)) {
        results.errors.push({ hostname, error: '资产类型不受支持' });
        continue;
      }
      if (assetType === 'computer') {
        results.errors.push({ hostname, error: '电脑类资产请通过 Agent 自动上报' });
        continue;
      }

      const serialNumber = normalizeSerial(item.serial_number);
      const ip = normalizeIp(item.ip) ?? null;
      const lifecycleStatus = normalizeLifecycleStatus(item.lifecycle_status);
      const pingEnabled = item.ping_enabled === false ? 0 : (ip ? 1 : 0);
      const byHostname = findByHostname.get(hostname);
      const bySerial = serialNumber ? findBySerial.get(serialNumber) : null;
      if ([byHostname, bySerial].some(asset => asset && asset.source !== 'manual')) {
        results.errors.push({ hostname, error: '不能通过批量录入修改 Agent 资产' });
        continue;
      }
      if (byHostname && bySerial && byHostname.id !== bySerial.id) {
        results.errors.push({ hostname, error: '资产名称与序列号匹配到不同资产' });
        continue;
      }

      const id = byHostname?.id || bySerial?.id || uuidv4();
      const before = byHostname || bySerial
        ? db.prepare('SELECT * FROM assets WHERE id=?').get(id)
        : null;
      const values = [
        hostname, assetType, cleanText(item.manufacturer) ?? null,
        cleanText(item.model) ?? null, serialNumber, ip,
        cleanText(item.mac_address) ?? null, cleanText(item.location) ?? null,
        cleanText(item.department) ?? null, cleanText(item.owner) ?? null,
        cleanText(item.asset_tag) ?? null, cleanText(item.notes) ?? null,
        lifecycleStatus, pingEnabled
      ];
      if (before) {
        update.run(...values, id);
        results.updated += 1;
      } else {
        insert.run(id, ...values);
        results.created += 1;
      }
      if (id) {
        const saved = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
        const summary = before
          ? summarizeAssetChanges(before, saved, [
              'hostname', 'asset_type', 'manufacturer', 'model', 'serial_number',
              'ip', 'mac_address', 'location', 'department', 'owner', 'asset_tag',
              'notes', 'ping_enabled', 'lifecycle_status'
            ])
          : `新增：${hostname} · ${formatAssetValue('asset_type', assetType)} · 状态 ${lifecycleLabel(lifecycleStatus)}`;
        if (summary) {
          recordAssetEvent(id, before ? 'bulk_update' : 'bulk_create',
            req.user?.sub || 'admin', summary);
        }
      }
    } catch (error) {
      results.errors.push({ hostname: cleanText(item?.hostname) ?? '', error: error.message });
    }
  }

  res.json(results);
});

// ── Lifecycle transactions, relations and attachments ───────────────────────
app.get('/api/transactions', requirePermission('lifecycle:read'), (req, res) => {
  const where = req.user.role === 'employee' ? 'WHERE t.requested_by=?' : '';
  const params = req.user.role === 'employee' ? [req.user.id] : [];
  const rows = db.prepare(`SELECT t.*,a.hostname,a.asset_tag,a.lifecycle_status,
    u.display_name as requester_name, o.display_name as approver_name,
    to_user.display_name as to_owner_name
    FROM asset_transactions t JOIN assets a ON a.id=t.asset_id
    LEFT JOIN users u ON u.id=t.requested_by LEFT JOIN users o ON o.id=t.approved_by
    LEFT JOIN users to_user ON to_user.id=t.to_owner_user_id
    ${where} ORDER BY t.created_at DESC`).all(...params);
  res.json(rows.map(row => ({ ...row, type_label: TRANSACTION_LABELS[row.type] || row.type })));
});

app.post('/api/transactions', requireAnyPermission('lifecycle:write', 'lifecycle:request'), (req, res) => {
  const body = req.body || {};
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(body.asset_id);
  if (!asset) return res.status(404).json({ error: '资产不存在' });
  if (!assetScopedToUser(asset, req.user)) return res.status(403).json({ error: '无权操作此资产' });
  const type = cleanText(body.type);
  if (!TRANSACTION_TYPES.has(type)) return res.status(400).json({ error: '生命周期动作不受支持' });
  if (req.user.role === 'employee' && !hasPermission(req.user, 'lifecycle:write') &&
      !['assign', 'return', 'loan', 'loan_return', 'repair'].includes(type)) {
    return res.status(403).json({ error: '普通员工只能提交领用、归还、借用或送修申请' });
  }
  const toOwner = body.to_owner_user_id
    ? db.prepare('SELECT id,display_name,department FROM users WHERE id=? AND active=1').get(body.to_owner_user_id)
    : null;
  if (body.to_owner_user_id && !toOwner) return res.status(400).json({ error: '目标责任用户不存在或已停用' });
  let amount;
  try { amount = body.amount === undefined ? null : normalizeMoney(body.amount); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const id = uuidv4();
  const status = hasPermission(req.user, 'lifecycle:write') ? 'pending' : 'pending';
  db.prepare(`INSERT INTO asset_transactions
    (id,asset_id,type,status,requested_by,to_owner_user_id,to_department,to_location,due_at,amount,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, asset.id, type, status, req.user.id, toOwner?.id || null,
    cleanText(body.to_department) || toOwner?.department || null,
    cleanText(body.to_location) || null, cleanText(body.due_at) || null, amount,
    cleanText(body.notes) || null
  );
  const transaction = db.prepare('SELECT * FROM asset_transactions WHERE id=?').get(id);
  recordAssetEvent(asset.id, 'lifecycle_request', req.user.username, summarizeTransaction(transaction));
  audit(req, 'lifecycle.request', 'asset_transaction', id,
    `${TRANSACTION_LABELS[type]}申请：${asset.hostname}`, { asset_id: asset.id, type });
  if (req.user.role === 'employee') {
    notifyRole('asset_manager', `待审批：${TRANSACTION_LABELS[type]}`, `${asset.hostname} 有新的生命周期申请`, 'approval', 'asset_transaction', id, `transaction:${id}:manager`);
    notifyRole('admin', `待审批：${TRANSACTION_LABELS[type]}`, `${asset.hostname} 有新的生命周期申请`, 'approval', 'asset_transaction', id, `transaction:${id}:admin`);
  }
  res.status(201).json(transaction);
});

app.patch('/api/transactions/:id/decision', requirePermission('lifecycle:write'), (req, res) => {
  const transaction = db.prepare('SELECT * FROM asset_transactions WHERE id=?').get(req.params.id);
  if (!transaction) return res.status(404).json({ error: '申请不存在' });
  if (transaction.status !== 'pending') return res.status(409).json({ error: '该申请已经处理' });
  const decision = cleanText(req.body?.decision);
  if (!['approve', 'reject', 'cancel'].includes(decision)) return res.status(400).json({ error: '决定不受支持' });
  const decisionNote = cleanText(req.body?.decision_note) || null;
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(transaction.asset_id);
  if (!asset) return res.status(404).json({ error: '关联资产不存在' });
  if (decision === 'approve') {
    const nextStatus = transitionForTransaction(transaction.type);
    db.exec('BEGIN');
    try {
      const ownerChange = ['assign', 'loan', 'transfer'].includes(transaction.type) && transaction.to_owner_user_id;
      const clearOwner = ['return', 'loan_return'].includes(transaction.type);
      const updates = [
        'lifecycle_status=?', "lifecycle_updated_at=datetime('now')",
        "updated_at=datetime('now')"
      ];
      const values = [nextStatus];
      if (ownerChange) {
        const target = db.prepare('SELECT display_name,department FROM users WHERE id=?').get(transaction.to_owner_user_id);
        updates.push('owner_user_id=?','owner=?'); values.push(transaction.to_owner_user_id, target?.display_name || null);
        if (transaction.to_department || target?.department) { updates.push('department=?'); values.push(transaction.to_department || target.department); }
      } else if (clearOwner) {
        updates.push('owner_user_id=NULL','owner=NULL');
      }
      if (transaction.to_location) { updates.push('location=?'); values.push(transaction.to_location); }
      if (transaction.type === 'purchase' && transaction.amount != null) updates.push('purchase_cost=?'), values.push(transaction.amount);
      if (['retire', 'recycle'].includes(transaction.type)) updates.push("retired_at=datetime('now')");
      if (transaction.type === 'enable') updates.push('retired_at=NULL','retired_reason=NULL');
      values.push(asset.id);
      db.prepare(`UPDATE assets SET ${updates.join(',')} WHERE id=?`).run(...values);
      db.prepare(`UPDATE asset_transactions SET status='approved',approved_by=?,decision_note=?,decided_at=datetime('now'),completed_at=datetime('now') WHERE id=?`)
        .run(req.user.id, decisionNote, transaction.id);
      const updated = db.prepare('SELECT * FROM assets WHERE id=?').get(asset.id);
      recordAssetEvent(asset.id, 'lifecycle_approve', req.user.username,
        `${TRANSACTION_LABELS[transaction.type]}：${lifecycleLabel(asset.lifecycle_status)} → ${lifecycleLabel(nextStatus)}`);
      audit(req, 'lifecycle.approve', 'asset_transaction', transaction.id,
        `批准${TRANSACTION_LABELS[transaction.type]}：${asset.hostname}`, { asset_id: asset.id, next_status: nextStatus });
      if (transaction.requested_by) createNotification(transaction.requested_by, '申请已批准',
        `${asset.hostname} 的${TRANSACTION_LABELS[transaction.type]}申请已批准`, 'success', 'asset_transaction', transaction.id, `transaction:${transaction.id}:approved`);
      db.exec('COMMIT');
      return res.json({ ...transaction, status: 'approved', asset: assetResponse(updated) });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.prepare(`UPDATE asset_transactions SET status=?,approved_by=?,decision_note=?,decided_at=datetime('now') WHERE id=?`)
    .run(decision === 'reject' ? 'rejected' : 'cancelled', req.user.id, decisionNote, transaction.id);
  audit(req, `lifecycle.${decision}`, 'asset_transaction', transaction.id,
    `${decision === 'reject' ? '驳回' : '取消'}${TRANSACTION_LABELS[transaction.type]}：${asset.hostname}`);
  if (transaction.requested_by) createNotification(transaction.requested_by, '申请状态更新',
    `${asset.hostname} 的${TRANSACTION_LABELS[transaction.type]}申请已${decision === 'reject' ? '驳回' : '取消'}`,
    decision === 'reject' ? 'error' : 'info', 'asset_transaction', transaction.id, `transaction:${transaction.id}:${decision}`);
  res.json({ ...transaction, status: decision === 'reject' ? 'rejected' : 'cancelled' });
});

// Compatibility aliases for the first lifecycle UI contract.
app.post('/api/assets/:id/lifecycle-requests', requireAnyPermission('lifecycle:write', 'lifecycle:request'), (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: '资产不存在' });
  const body = req.body || {};
  const type = cleanText(body.action);
  if (!TRANSACTION_TYPES.has(type)) return res.status(400).json({ error: '生命周期动作不受支持' });
  const target = body.target_user_id ? db.prepare('SELECT id,display_name,department FROM users WHERE id=? AND active=1').get(body.target_user_id) : null;
  if (body.target_user_id && !target) return res.status(400).json({ error: '目标用户不存在或已停用' });
  const id = uuidv4();
  db.prepare(`INSERT INTO asset_transactions (id,asset_id,type,status,requested_by,to_owner_user_id,to_department,notes)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, asset.id, type, 'pending', req.user.id, target?.id || null, target?.department || null, cleanText(body.reason) || null);
  const transaction = db.prepare('SELECT * FROM asset_transactions WHERE id=?').get(id);
  audit(req, 'lifecycle.request', 'asset_transaction', id, `创建生命周期申请：${asset.hostname}`);
  res.status(201).json({ request: transaction });
});

app.post('/api/lifecycle-requests/:id/approve', requirePermission('lifecycle:write'), (req, res) => {
  const transaction = db.prepare('SELECT * FROM asset_transactions WHERE id=?').get(req.params.id);
  if (!transaction) return res.status(404).json({ error: '申请不存在' });
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(transaction.asset_id);
  if (!asset) return res.status(404).json({ error: '资产不存在' });
  const approved = req.body?.decision === 'approved' || req.body?.decision === 'approve';
  if (!approved) {
    db.prepare(`UPDATE asset_transactions SET status='rejected',approved_by=?,decision_note=?,decided_at=datetime('now') WHERE id=?`)
      .run(req.user.id, cleanText(req.body?.decision_note), transaction.id);
    audit(req, 'lifecycle.reject', 'asset_transaction', transaction.id, `驳回生命周期申请：${asset.hostname}`);
    return res.json({ request: { ...transaction, status: 'rejected' } });
  }
  const nextStatus = transitionForTransaction(transaction.type);
  const updates = ['lifecycle_status=?', "lifecycle_updated_at=datetime('now')", "updated_at=datetime('now')"];
  const values = [nextStatus];
  if (transaction.to_owner_user_id) {
    const target = db.prepare('SELECT display_name,department FROM users WHERE id=?').get(transaction.to_owner_user_id);
    updates.push('owner_user_id=?','owner=?','department=?'); values.push(transaction.to_owner_user_id, target?.display_name || null, transaction.to_department || target?.department || null);
  }
  values.push(asset.id);
  db.prepare(`UPDATE assets SET ${updates.join(',')} WHERE id=?`).run(...values);
  db.prepare(`UPDATE asset_transactions SET status='approved',approved_by=?,decision_note=?,decided_at=datetime('now'),completed_at=datetime('now') WHERE id=?`)
    .run(req.user.id, cleanText(req.body?.decision_note) || null, transaction.id);
  audit(req, 'lifecycle.approve', 'asset_transaction', transaction.id, `批准生命周期申请：${asset.hostname}`);
  res.json({ request: { ...transaction, status: 'approved' } });
});

app.post('/api/assets/:id/relations', requirePermission('asset:write'), (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  const related = db.prepare('SELECT id,hostname FROM assets WHERE id=?').get(req.body?.related_asset_id);
  if (!asset || !related) return res.status(404).json({ error: '资产不存在' });
  if (asset.id === related.id) return res.status(400).json({ error: '不能关联自身' });
  const id = uuidv4();
  try {
    db.prepare(`INSERT INTO asset_relations (id,asset_id,related_asset_id,relation_type,created_by)
      VALUES (?,?,?,?,?)`).run(id, asset.id, related.id, cleanText(req.body?.relation_type) || 'depends_on', req.user.id);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '关系已经存在' });
    throw error;
  }
  audit(req, 'asset.relation.create', 'asset_relation', id, `建立资产关系：${asset.hostname} → ${related.hostname}`);
  res.status(201).json(db.prepare(`SELECT r.id,r.relation_type,r.related_asset_id,a.hostname,a.asset_type,a.asset_tag
    FROM asset_relations r JOIN assets a ON a.id=r.related_asset_id WHERE r.id=?`).get(id));
});

app.delete('/api/assets/:id/relations/:relationId', requirePermission('asset:write'), (req, res) => {
  const result = db.prepare('DELETE FROM asset_relations WHERE id=? AND asset_id=?').run(req.params.relationId, req.params.id);
  if (!result.changes) return res.status(404).json({ error: '关系不存在' });
  audit(req, 'asset.relation.delete', 'asset_relation', req.params.relationId, '删除资产关系');
  res.json({ ok: true });
});

function canAccessEntity(req, entityType, entityId) {
  if (entityType === 'asset') {
    const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(entityId);
    return asset && assetScopedToUser(asset, req.user);
  }
  if (entityType === 'work_order') {
    const order = db.prepare('SELECT * FROM work_orders WHERE id=?').get(entityId);
    return order && (req.user.role !== 'employee' || order.requester_user_id === req.user.id || order.assignee_user_id === req.user.id);
  }
  return false;
}

app.get('/api/attachments', requirePermission('attachment:read'), (req, res) => {
  const entityType = cleanText(req.query.entity_type);
  const entityId = cleanText(req.query.entity_id);
  if (!entityType || !entityId || !canAccessEntity(req, entityType, entityId)) return res.status(403).json({ error: '无权查看附件' });
  res.json(db.prepare(`SELECT id,entity_type,entity_id,original_name,mime_type,size_bytes,uploaded_by,created_at
    FROM attachments WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC`).all(entityType, entityId));
});

app.get('/api/assets/:id/attachments', requirePermission('attachment:read'), (req, res) => {
  if (!canAccessEntity(req, 'asset', req.params.id)) return res.status(403).json({ error: '无权查看附件' });
  res.json({ attachments: db.prepare(`SELECT id,entity_type,entity_id,original_name,mime_type,size_bytes,uploaded_by,created_at
    FROM attachments WHERE entity_type='asset' AND entity_id=? ORDER BY created_at DESC`).all(req.params.id) });
});

app.post('/api/attachments', requirePermission('attachment:write'), upload.single('file'), (req, res) => {
  const entityType = cleanText(req.body?.entity_type);
  const entityId = cleanText(req.body?.entity_id);
  if (!entityType || !entityId || !req.file) return res.status(400).json({ error: 'entity_type、entity_id 和 file 必填' });
  if (!['asset', 'work_order'].includes(entityType) || !canAccessEntity(req, entityType, entityId)) {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
    return res.status(403).json({ error: '无权上传附件' });
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO attachments
    (id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,uploaded_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    id, entityType, entityId, req.file.originalname, req.file.filename, req.file.mimetype,
    req.file.size, req.user.id
  );
  audit(req, 'attachment.create', 'attachment', id, `上传附件：${req.file.originalname}`, { entity_type: entityType, entity_id: entityId });
  res.status(201).json(db.prepare(`SELECT id,entity_type,entity_id,original_name,mime_type,size_bytes,uploaded_by,created_at
    FROM attachments WHERE id=?`).get(id));
});

app.post('/api/assets/:id/attachments', requirePermission('attachment:write'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file 必填' });
  if (!canAccessEntity(req, 'asset', req.params.id)) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(403).json({ error: '无权上传附件' });
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO attachments (id,entity_type,entity_id,original_name,stored_name,mime_type,size_bytes,uploaded_by)
    VALUES (?,'asset',?,?,?,?,?,?)`).run(id, req.params.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id);
  audit(req, 'attachment.create', 'attachment', id, `上传附件：${req.file.originalname}`, { entity_type: 'asset', entity_id: req.params.id });
  res.status(201).json({ attachment: db.prepare(`SELECT id,entity_type,entity_id,original_name,mime_type,size_bytes,uploaded_by,created_at FROM attachments WHERE id=?`).get(id) });
});

app.get('/api/attachments/:id/download', requirePermission('attachment:read'), (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
  if (!attachment || !canAccessEntity(req, attachment.entity_type, attachment.entity_id)) return res.status(404).json({ error: '附件不存在' });
  const filePath = path.join(UPLOAD_DIR, attachment.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '附件文件不存在' });
  res.download(filePath, attachment.original_name);
});

app.delete('/api/attachments/:id', requirePermission('attachment:write'), (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
  if (!attachment || !canAccessEntity(req, attachment.entity_type, attachment.entity_id)) return res.status(404).json({ error: '附件不存在' });
  db.prepare('DELETE FROM attachments WHERE id=?').run(attachment.id);
  fs.rmSync(path.join(UPLOAD_DIR, attachment.stored_name), { force: true });
  audit(req, 'attachment.delete', 'attachment', attachment.id, `删除附件：${attachment.original_name}`);
  res.json({ ok: true });
});

// ── Work orders and notifications ────────────────────────────────────────────
function workOrderResponse(order) {
  if (!order) return order;
  return {
    ...order,
    requester_name: order.requester_name || null,
    assignee_name: order.assignee_name || null,
    comments: order.comments || [],
    attachments: order.attachments || []
  };
}

function workOrderQuery(scopeUser) {
  const where = scopeUser?.role === 'employee' ? 'WHERE w.requester_user_id=? OR w.assignee_user_id=?' : '';
  const params = scopeUser?.role === 'employee' ? [scopeUser.id, scopeUser.id] : [];
  const rows = db.prepare(`SELECT w.*,a.hostname,a.asset_tag,
    requester.display_name as requester_name, assignee.display_name as assignee_name
    FROM work_orders w LEFT JOIN assets a ON a.id=w.asset_id
    LEFT JOIN users requester ON requester.id=w.requester_user_id
    LEFT JOIN users assignee ON assignee.id=w.assignee_user_id
    ${where} ORDER BY CASE w.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, w.updated_at DESC`).all(...params);
  return rows.map(row => workOrderResponse(row));
}

app.get('/api/work-orders', requirePermission('work:read'), (req, res) => res.json(workOrderQuery(req.user)));

app.get('/api/work-orders/:id', requirePermission('work:read'), (req, res) => {
  const rows = db.prepare(`SELECT w.*,a.hostname,a.asset_tag,
    requester.display_name as requester_name, assignee.display_name as assignee_name
    FROM work_orders w LEFT JOIN assets a ON a.id=w.asset_id
    LEFT JOIN users requester ON requester.id=w.requester_user_id
    LEFT JOIN users assignee ON assignee.id=w.assignee_user_id WHERE w.id=?`).all(req.params.id);
  if (!rows.length) return res.status(404).json({ error: '工单不存在' });
  const order = rows[0];
  if (req.user.role === 'employee' && order.requester_user_id !== req.user.id && order.assignee_user_id !== req.user.id) {
    return res.status(403).json({ error: '无权查看此工单' });
  }
  order.comments = db.prepare(`SELECT c.*,u.display_name as author_name FROM work_order_comments c
    LEFT JOIN users u ON u.id=c.author_user_id WHERE c.work_order_id=? ORDER BY c.created_at`).all(order.id);
  order.attachments = db.prepare(`SELECT id,original_name,mime_type,size_bytes,uploaded_by,created_at
    FROM attachments WHERE entity_type='work_order' AND entity_id=? ORDER BY created_at DESC`).all(order.id);
  res.json(workOrderResponse(order));
});

app.post('/api/work-orders', requirePermission('work:write'), (req, res) => {
  const body = req.body || {};
  const title = cleanText(body.title);
  if (!title) return res.status(400).json({ error: '工单标题不能为空' });
  const asset = body.asset_id ? db.prepare('SELECT * FROM assets WHERE id=?').get(body.asset_id) : null;
  if (body.asset_id && !asset) return res.status(404).json({ error: '关联资产不存在' });
  if (asset && !assetScopedToUser(asset, req.user) && req.user.role === 'employee') return res.status(403).json({ error: '无权关联此资产' });
  const assignee = body.assignee_user_id
    ? db.prepare('SELECT id,display_name FROM users WHERE id=? AND active=1').get(body.assignee_user_id)
    : null;
  if (body.assignee_user_id && !assignee) return res.status(400).json({ error: '处理人不存在或已停用' });
  const type = cleanText(body.type) || 'request';
  const priority = cleanText(body.priority) || 'normal';
  if (!['request', 'incident', 'repair', 'change'].includes(type)) return res.status(400).json({ error: '工单类型不受支持' });
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return res.status(400).json({ error: '优先级不受支持' });
  const id = uuidv4();
  const number = `WO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(db.prepare('SELECT COUNT(*) as c FROM work_orders').get().c + 1).padStart(4, '0')}`;
  db.prepare(`INSERT INTO work_orders (id,number,title,description,asset_id,type,priority,status,requester_user_id,assignee_user_id,due_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, number, title, cleanText(body.description) || null, asset?.id || null, type, priority,
    'open', req.user.id, assignee?.id || null, cleanText(body.due_at) || null
  );
  if (assignee) createNotification(assignee.id, '新工单分派', `${number}：${title}`, 'work_order', 'work_order', id, `work:${id}:assigned:${assignee.id}`);
  audit(req, 'work_order.create', 'work_order', id, `创建工单：${number} ${title}`);
  res.status(201).json(db.prepare('SELECT * FROM work_orders WHERE id=?').get(id));
});

app.post('/api/work-orders/:id/assign', requirePermission('work:write'), (req, res) => {
  const order = db.prepare('SELECT * FROM work_orders WHERE id=?').get(req.params.id);
  const assignee = db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(req.body?.user_id);
  if (!order) return res.status(404).json({ error: '工单不存在' });
  if (!assignee) return res.status(400).json({ error: '处理人不存在或已停用' });
  db.prepare("UPDATE work_orders SET assignee_user_id=?,updated_at=datetime('now') WHERE id=?").run(assignee.id, order.id);
  createNotification(assignee.id, '新工单分派', `${order.number}：${order.title}`, 'work_order', 'work_order', order.id, `work:${order.id}:assigned:${assignee.id}`);
  audit(req, 'work_order.assign', 'work_order', order.id, `分派工单：${order.number}`);
  res.json({ work_order: db.prepare('SELECT * FROM work_orders WHERE id=?').get(order.id) });
});

app.patch('/api/work-orders/:id', requirePermission('work:write'), (req, res) => {
  const order = db.prepare('SELECT * FROM work_orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: '工单不存在' });
  if (req.user.role === 'employee' && order.requester_user_id !== req.user.id && order.assignee_user_id !== req.user.id) {
    return res.status(403).json({ error: '无权修改此工单' });
  }
  const body = req.body || {};
  const updates = [];
  const values = [];
  for (const field of ['title', 'description', 'due_at']) {
    if (body[field] !== undefined) { updates.push(`${field}=?`); values.push(cleanText(body[field])); }
  }
  if (body.status !== undefined) {
    if (!['open', 'in_progress', 'pending', 'resolved', 'closed', 'cancelled'].includes(body.status)) return res.status(400).json({ error: '工单状态不受支持' });
    updates.push('status=?'); values.push(body.status);
    if (['resolved', 'closed'].includes(body.status)) updates.push("resolved_at=datetime('now')");
  }
  if (body.priority !== undefined) {
    if (!['low', 'normal', 'high', 'urgent'].includes(body.priority)) return res.status(400).json({ error: '优先级不受支持' });
    updates.push('priority=?'); values.push(body.priority);
  }
  if (body.assignee_user_id !== undefined) {
    const assignee = body.assignee_user_id
      ? db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(body.assignee_user_id)
      : null;
    if (body.assignee_user_id && !assignee) return res.status(400).json({ error: '处理人不存在或已停用' });
    updates.push('assignee_user_id=?'); values.push(assignee?.id || null);
    if (assignee && assignee.id !== order.assignee_user_id) createNotification(assignee.id, '工单分派', `${order.number}：${order.title}`, 'work_order', 'work_order', order.id, `work:${order.id}:assigned:${assignee.id}`);
  }
  if (!updates.length) return res.json(order);
  updates.push("updated_at=datetime('now')"); values.push(order.id);
  db.prepare(`UPDATE work_orders SET ${updates.join(',')} WHERE id=?`).run(...values);
  const updated = db.prepare('SELECT * FROM work_orders WHERE id=?').get(order.id);
  audit(req, 'work_order.update', 'work_order', order.id, `更新工单：${order.number}`, { status: updated.status });
  if (updated.requester_user_id && updated.status !== order.status) createNotification(updated.requester_user_id, '工单状态更新', `${updated.number}：${updated.status}`, 'work_order', 'work_order', updated.id, `work:${updated.id}:status:${updated.status}`);
  res.json(updated);
});

app.post('/api/work-orders/:id/comments', requirePermission('work:write'), (req, res) => {
  const order = db.prepare('SELECT * FROM work_orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: '工单不存在' });
  if (req.user.role === 'employee' && order.requester_user_id !== req.user.id && order.assignee_user_id !== req.user.id) return res.status(403).json({ error: '无权评论此工单' });
  const body = cleanText(req.body?.body);
  if (!body) return res.status(400).json({ error: '评论内容不能为空' });
  const result = db.prepare('INSERT INTO work_order_comments (work_order_id,author_user_id,body) VALUES (?,?,?)')
    .run(order.id, req.user.id, body);
  db.prepare("UPDATE work_orders SET updated_at=datetime('now') WHERE id=?").run(order.id);
  audit(req, 'work_order.comment', 'work_order', order.id, `工单评论：${order.number}`);
  const watchers = [order.requester_user_id, order.assignee_user_id].filter(id => id && id !== req.user.id);
  watchers.forEach(userId => createNotification(userId, '工单有新评论', `${order.number}：${body.slice(0, 80)}`, 'work_order', 'work_order', order.id, `work:${order.id}:comment:${result.lastInsertRowid}:${userId}`));
  res.status(201).json(db.prepare(`SELECT c.*,u.display_name as author_name FROM work_order_comments c
    LEFT JOIN users u ON u.id=c.author_user_id WHERE c.id=?`).get(result.lastInsertRowid));
});

app.get('/api/notifications', requirePermission('notification:read'), (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  res.json(db.prepare(`SELECT * FROM notifications WHERE user_id=?
    ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, created_at DESC LIMIT ?`).all(req.user.id, limit));
});

app.patch('/api/notifications/:id/read', requirePermission('notification:read'), (req, res) => {
  const result = db.prepare("UPDATE notifications SET read_at=datetime('now') WHERE id=? AND user_id=?")
    .run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: '通知不存在' });
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', requirePermission('notification:read'), (req, res) => {
  const result = db.prepare("UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL")
    .run(req.user.id);
  res.json({ ok: true, updated: result.changes });
});

app.get('/api/audit', requirePermission('audit:read'), (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT ?`).all(limit);
  res.json(rows.map(row => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null })));
});

// ── Dashboard, reports and integration adapters ────────────────────────────────
app.get('/api/dashboard', requirePermission('asset:read'), (req, res) => {
  const assets = req.user.role === 'employee'
    ? db.prepare('SELECT * FROM assets WHERE owner_user_id=? OR owner=? OR owner=?').all(req.user.id, req.user.display_name, req.user.username)
    : db.prepare('SELECT * FROM assets').all();
  const today = new Date().toISOString().slice(0, 10);
  const warrantySoon = assets.filter(asset => asset.warranty_expires_at && asset.warranty_expires_at <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  const lifecycle = Object.fromEntries(Object.keys(LIFECYCLE_LABELS).map(status => [status, assets.filter(asset => asset.lifecycle_status === status || (status === 'in_stock' && asset.lifecycle_status === 'spare')).length]));
  const workWhere = req.user.role === 'employee' ? 'WHERE requester_user_id=? OR assignee_user_id=?' : '';
  const workParams = req.user.role === 'employee' ? [req.user.id, req.user.id] : [];
  const workOrders = db.prepare(`SELECT status,COUNT(*) as count FROM work_orders ${workWhere} GROUP BY status`).all(...workParams);
  const unread = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).c;
  const pending = req.user.role === 'employee' ? 0 : db.prepare("SELECT COUNT(*) as c FROM asset_transactions WHERE status='pending'").get().c;
  const recentAssets = assets.slice().sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''))).slice(0, 8).map(assetResponse);
  const pendingTransactions = req.user.role === 'employee' ? [] : db.prepare(`SELECT t.*,a.hostname,a.asset_tag
    FROM asset_transactions t JOIN assets a ON a.id=t.asset_id WHERE t.status='pending' ORDER BY t.created_at DESC LIMIT 8`).all();
  const recentWorkOrders = db.prepare(`SELECT w.*,a.hostname FROM work_orders w LEFT JOIN assets a ON a.id=w.asset_id
    ${req.user.role === 'employee' ? 'WHERE w.requester_user_id=? OR w.assignee_user_id=?' : ''}
    ORDER BY w.updated_at DESC LIMIT 8`).all(...workParams);
  const recentNotifications = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 8').all(req.user.id);
  res.json({
    assets: { total: assets.length, online: assets.filter(asset => assetOnlineStatus(asset) === 'online').length,
      agent: assets.filter(asset => asset.source === 'agent').length, manual: assets.filter(asset => asset.source === 'manual').length },
    lifecycle, warranty_soon: warrantySoon.length,
    work_orders: Object.fromEntries(workOrders.map(row => [row.status, row.count])),
    unread_notifications: unread, pending_transactions: pending, today,
    recent_assets: recentAssets, pending_items: pendingTransactions,
    recent_work_orders: recentWorkOrders, recent_notifications: recentNotifications
  });
});

app.get('/api/reports/summary', requirePermission('report:read'), (req, res) => {
  const assets = db.prepare('SELECT * FROM assets ORDER BY hostname').all();
  const totalCost = assets.reduce((sum, asset) => sum + Number(asset.purchase_cost || 0), 0);
  const totalBookValue = assets.reduce((sum, asset) => sum + bookValue(asset), 0);
  const warrantyExpiring = assets.filter(asset => {
    if (!asset.warranty_expires_at) return false;
    const expiry = new Date(`${asset.warranty_expires_at}T23:59:59Z`).getTime();
    return expiry >= Date.now() && expiry <= Date.now() + 90 * 86400000;
  }).length;
  const openWorkOrders = db.prepare("SELECT COUNT(*) as c FROM work_orders WHERE status NOT IN ('resolved','closed','cancelled')").get().c;
  const byDepartment = db.prepare(`SELECT COALESCE(department,'未分配') as label,COUNT(*) as count,
    COALESCE(SUM(purchase_cost),0) as purchase_cost FROM assets GROUP BY department ORDER BY count DESC`).all();
  const byLifecycle = db.prepare(`SELECT lifecycle_status as label,COUNT(*) as count FROM assets GROUP BY lifecycle_status ORDER BY count DESC`).all();
  res.json({
    total_assets: assets.length,
    total_cost: Number(totalCost.toFixed(2)),
    total_book_value: Number(totalBookValue.toFixed(2)),
    warranty_expiring: warrantyExpiring,
    open_work_orders: openWorkOrders,
    by_department: byDepartment,
    by_lifecycle: byLifecycle
  });
});

const INTEGRATION_TYPES = new Set(['ad', 'mdm', 'snmp', 'aws', 'azure', 'gcp', 'webhook', 'manual']);
function integrationResponse(row) {
  if (!row) return row;
  const { config_json: _secretConfig, ...safe } = row;
  return {
    ...safe,
    enabled: Boolean(row.enabled),
    config: row.config_json ? JSON.parse(row.config_json) : {},
    secret_ref: row.secret_ref || null
  };
}

app.get('/api/integrations', requirePermission('integration:read'), (req, res) => {
  res.json(db.prepare('SELECT * FROM integrations ORDER BY name').all().map(integrationResponse));
});

app.post('/api/integrations', requirePermission('integration:manage'), (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name);
  const type = cleanText(body.type);
  if (!name || !INTEGRATION_TYPES.has(type)) return res.status(400).json({ error: '集成名称或类型不正确' });
  const id = uuidv4();
  db.prepare(`INSERT INTO integrations (id,name,type,enabled,endpoint,secret_ref,config_json,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, name, type, body.enabled ? 1 : 0,
    cleanText(body.endpoint) || null, cleanText(body.secret_ref) || null,
    JSON.stringify(body.config && typeof body.config === 'object' ? body.config : {}),
    cleanText(body.notes) || null, req.user.id);
  audit(req, 'integration.create', 'integration', id, `创建集成：${name}`, { type });
  res.status(201).json(integrationResponse(db.prepare('SELECT * FROM integrations WHERE id=?').get(id)));
});

app.patch('/api/integrations/:id', requirePermission('integration:manage'), (req, res) => {
  const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!integration) return res.status(404).json({ error: '集成不存在' });
  const body = req.body || {};
  const updates = [];
  const values = [];
  for (const field of ['name', 'type', 'endpoint', 'secret_ref']) {
    if (body[field] !== undefined) {
      if (field === 'type' && !INTEGRATION_TYPES.has(body[field])) return res.status(400).json({ error: '集成类型不受支持' });
      updates.push(`${field}=?`); values.push(cleanText(body[field]));
    }
  }
  if (body.enabled !== undefined) { updates.push('enabled=?'); values.push(body.enabled ? 1 : 0); }
  if (body.config !== undefined) { updates.push('config_json=?'); values.push(JSON.stringify(body.config || {})); }
  if (body.notes !== undefined) { updates.push('notes=?'); values.push(cleanText(body.notes) || null); }
  if (!updates.length) return res.json(integrationResponse(integration));
  updates.push("updated_at=datetime('now')"); values.push(integration.id);
  db.prepare(`UPDATE integrations SET ${updates.join(',')} WHERE id=?`).run(...values);
  audit(req, 'integration.update', 'integration', integration.id, `更新集成：${integration.name}`);
  res.json(integrationResponse(db.prepare('SELECT * FROM integrations WHERE id=?').get(integration.id)));
});

app.post('/api/integrations/:id/sync', requirePermission('integration:manage'), (req, res) => {
  const integration = db.prepare('SELECT * FROM integrations WHERE id=?').get(req.params.id);
  if (!integration) return res.status(404).json({ error: '集成不存在' });
  const runId = uuidv4();
  const configured = integration.type === 'manual' || (integration.endpoint && integration.secret_ref);
  const status = configured ? 'queued' : 'needs_configuration';
  const message = configured ? '已创建同步任务；当前版本等待对应适配器执行' : '请配置 endpoint 和 secret_ref 后再同步';
  db.prepare(`INSERT INTO integration_runs (id,integration_id,status,message) VALUES (?,?,?,?)`)
    .run(runId, integration.id, status, message);
  db.prepare("UPDATE integrations SET last_sync_at=datetime('now'),last_status=?,updated_at=datetime('now') WHERE id=?")
    .run(status, integration.id);
  audit(req, 'integration.sync', 'integration', integration.id, `触发集成同步：${integration.name}`, { run_id: runId, status });
  res.json({ run: db.prepare('SELECT * FROM integration_runs WHERE id=?').get(runId), status, integration: integrationResponse(db.prepare('SELECT * FROM integrations WHERE id=?').get(integration.id)) });
});

app.get('/api/integrations/:id/runs', requirePermission('integration:read'), (req, res) => {
  if (!db.prepare('SELECT id FROM integrations WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '集成不存在' });
  res.json(db.prepare('SELECT * FROM integration_runs WHERE integration_id=? ORDER BY started_at DESC').all(req.params.id));
});

app.post('/api/assets/:id/ping', requirePermission('asset:write'), async (req, res) => {
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

app.delete('/api/assets/:id', requirePermission('asset:delete'), (req, res) => {
  const result = db.prepare('DELETE FROM assets WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'asset not found' });
  audit(req, 'asset.delete', 'asset', req.params.id, '删除资产');
  res.json({ ok: true, deleted: result.changes });
});

app.get('/api/assets/:id/vnc', requirePermission('asset:read'), (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!assetScopedToUser(a, req.user)) return res.status(403).json({ error: '无权访问此资产' });
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
function inventoryDifferences(sessionId) {
  const expected = db.prepare(`SELECT e.*,a.hostname,a.asset_tag,a.location,a.owner,a.department,a.lifecycle_status
    FROM inventory_expected e JOIN assets a ON a.id=e.asset_id WHERE e.session_id=? ORDER BY a.hostname`).all(sessionId);
  const records = db.prepare(`SELECT r.*,a.hostname,a.asset_tag,a.location,a.owner,a.department,a.lifecycle_status
    FROM inventory_records r JOIN assets a ON a.id=r.asset_id WHERE r.session_id=?`).all(sessionId);
  const recordMap = new Map(records.map(row => [row.asset_id, row]));
  const rows = [];
  for (const item of expected) {
    const record = recordMap.get(item.asset_id);
    if (!record) rows.push({ asset_id: item.asset_id, hostname: item.hostname, asset_tag: item.asset_tag, difference_type: 'missing', expected_location: item.expected_location, actual_location: null, resolved: false });
    else if (item.expected_location && record.scanned_location && item.expected_location !== record.scanned_location) {
      rows.push({ asset_id: item.asset_id, hostname: item.hostname, asset_tag: item.asset_tag, difference_type: 'location_mismatch', expected_location: item.expected_location, actual_location: record.scanned_location, resolved: false });
    }
  }
  for (const record of records) {
    if (!expected.some(item => item.asset_id === record.asset_id)) rows.push({ asset_id: record.asset_id, hostname: record.hostname, asset_tag: record.asset_tag, difference_type: 'unexpected', expected_location: null, actual_location: record.scanned_location, resolved: false });
  }
  const resolutions = db.prepare('SELECT asset_id,difference_type,resolution,note,resolved_by,resolved_at FROM inventory_resolutions WHERE session_id=?').all(sessionId);
  const resolutionMap = new Map(resolutions.map(row => [`${row.asset_id}:${row.difference_type}`, row]));
  return rows.map(row => ({ ...row, resolution: resolutionMap.get(`${row.asset_id}:${row.difference_type}`) || null,
    resolved: Boolean(resolutionMap.has(`${row.asset_id}:${row.difference_type}`)) }));
}

app.get('/api/inventory', requirePermission('inventory:read'), (req, res) => {
  const sessions = db.prepare('SELECT * FROM inventory_sessions ORDER BY created_at DESC').all();
  sessions.forEach(s => {
    const expected = db.prepare('SELECT COUNT(*) as c FROM inventory_expected WHERE session_id=?').get(s.id).c;
    const scanned = db.prepare('SELECT COUNT(*) as c FROM inventory_records WHERE session_id=?').get(s.id).c;
    s.expected_count = expected || db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
    s.scanned_count = scanned;
    s.unresolved_count = inventoryDifferences(s.id).filter(row => !row.resolved).length;
    // Keep the legacy field for older clients; it represents scanned rows.
    s.total = scanned;
  });
  res.json(sessions);
});

app.post('/api/inventory', requirePermission('inventory:write'), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  const scanToken = uuidv4();
  db.prepare('INSERT INTO inventory_sessions (id,name,scan_token,scope_type,created_by) VALUES (?,?,?,?,?)')
    .run(id, name, scanToken, 'all', req.user?.id || null);
  const assets = db.prepare('SELECT id,location,owner,lifecycle_status FROM assets').all();
  const insertExpected = db.prepare(`INSERT INTO inventory_expected
    (session_id,asset_id,expected_location,expected_owner,expected_status) VALUES (?,?,?,?,?)`);
  assets.forEach(asset => insertExpected.run(id, asset.id, asset.location || null, asset.owner || null, asset.lifecycle_status || null));
  audit(req, 'inventory.create', 'inventory_session', id, `创建盘点场次：${name}`, { asset_count: assets.length });
  // Keep the legacy endpoint's 200 response while returning the new scan token.
  res.json({ id, scan_token: scanToken, session: { id, name, scan_token: scanToken, status: 'open' } });
});

app.patch('/api/inventory/:id/close', requirePermission('inventory:write'), (req, res) => {
  const session = db.prepare('SELECT status,closed_at FROM inventory_sessions WHERE id=?')
    .get(req.params.id);
  if (!session) return res.status(404).json({ error: 'inventory session not found' });
  if (session.status !== 'open') {
    return res.json({ ok: true, already_closed: true, closed_at: session.closed_at });
  }
  const differences = inventoryDifferences(req.params.id);
  const status = differences.some(row => !row.resolved) ? 'review' : 'closed';
  const result = db.prepare("UPDATE inventory_sessions SET status=?,closed_at=datetime('now') WHERE id=? AND status='open'")
    .run(status, req.params.id);
  if (result.changes === 0) return res.status(409).json({ error: '盘点状态已变化，请刷新后重试' });
  const closed = db.prepare('SELECT closed_at FROM inventory_sessions WHERE id=?').get(req.params.id);
  audit(req, 'inventory.close', 'inventory_session', req.params.id, `结束盘点：${status === 'review' ? '待处理差异' : '已关闭'}`);
  res.json({ ok: true, already_closed: false, review_required: status === 'review', closed_at: closed.closed_at });
});

app.patch('/api/inventory/:id/finalize', requirePermission('inventory:write'), (req, res) => {
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'inventory session not found' });
  const differences = inventoryDifferences(session.id);
  if (differences.some(row => !row.resolved)) return res.status(409).json({ error: '仍有未处理的盘点差异', differences });
  db.prepare("UPDATE inventory_sessions SET status='closed',closed_at=COALESCE(closed_at,datetime('now')) WHERE id=?").run(session.id);
  audit(req, 'inventory.finalize', 'inventory_session', session.id, `确认盘点完成：${session.name}`);
  res.json({ ok: true, status: 'closed' });
});

app.post('/api/inventory/:id/finalize', requirePermission('inventory:write'), (req, res) => {
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'inventory session not found' });
  const differences = inventoryDifferences(session.id);
  if (differences.some(row => !row.resolved)) return res.status(409).json({ error: '仍有未处理的盘点差异', differences });
  db.prepare("UPDATE inventory_sessions SET status='closed',closed_at=COALESCE(closed_at,datetime('now')) WHERE id=?").run(session.id);
  audit(req, 'inventory.finalize', 'inventory_session', session.id, `确认盘点完成：${session.name}`);
  res.json({ session: { ...session, status: 'closed' }, finalized: true });
});

app.delete('/api/inventory/:id', requirePermission('inventory:write'), (req, res) => {
  db.prepare('DELETE FROM inventory_records WHERE session_id=?').run(req.params.id);
  db.prepare('DELETE FROM inventory_sessions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Records within a session
app.get('/api/inventory/:id/records', requirePermission('inventory:read'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, a.hostname, a.ip, a.platform, a.location as asset_location,
           a.department, a.owner, a.asset_type, a.asset_tag
    FROM inventory_records r
    JOIN assets a ON a.id = r.asset_id
    WHERE r.session_id=? ORDER BY r.scanned_at DESC
  `).all(req.params.id);
  res.json(rows);
});

app.get('/api/inventory/:id/differences', requirePermission('inventory:read'), (req, res) => {
  const session = db.prepare('SELECT id,status,name FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: '盘点场次不存在' });
  const differences = inventoryDifferences(session.id);
  res.json({ session, differences,
    missing: differences.filter(row => row.difference_type === 'missing'),
    location: differences.filter(row => row.difference_type === 'location_mismatch'),
    unexpected: differences.filter(row => row.difference_type === 'unexpected') });
});

app.patch('/api/inventory/:id/differences/:assetId/resolve', requirePermission('inventory:write'), (req, res) => {
  const session = db.prepare('SELECT id FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: '盘点场次不存在' });
  const differenceType = cleanText(req.body?.difference_type);
  const resolution = cleanText(req.body?.resolution);
  if (!['missing', 'location_mismatch', 'unexpected'].includes(differenceType) || !resolution) return res.status(400).json({ error: '差异类型和处理结果必填' });
  const actual = inventoryDifferences(session.id).find(row => row.asset_id === req.params.assetId && row.difference_type === differenceType);
  if (!actual) return res.status(404).json({ error: '差异不存在' });
  db.prepare(`INSERT INTO inventory_resolutions (session_id,asset_id,difference_type,resolution,note,resolved_by)
    VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,asset_id,difference_type) DO UPDATE SET
      resolution=excluded.resolution,note=excluded.note,resolved_by=excluded.resolved_by,resolved_at=datetime('now')`).run(
    session.id, req.params.assetId, differenceType, resolution, cleanText(req.body?.note) || null, req.user.id
  );
  audit(req, 'inventory.difference.resolve', 'inventory_session', session.id, `处理盘点差异：${actual.hostname}`, { asset_id: req.params.assetId, difference_type: differenceType, resolution });
  res.json({ ok: true, differences: inventoryDifferences(session.id) });
});

app.post('/api/inventory/:id/resolutions', requirePermission('inventory:write'), (req, res) => {
  const session = db.prepare('SELECT id FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session || !Array.isArray(req.body?.resolutions)) return res.status(400).json({ error: '盘点场次或 resolutions 不正确' });
  const available = inventoryDifferences(session.id);
  for (const item of req.body.resolutions) {
    const differenceType = item.difference_type === 'location' ? 'location_mismatch' : item.difference_type;
    const actual = available.find(row => row.asset_id === item.asset_id && row.difference_type === differenceType);
    if (!actual) continue;
    db.prepare(`INSERT INTO inventory_resolutions (session_id,asset_id,difference_type,resolution,note,resolved_by)
      VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,asset_id,difference_type) DO UPDATE SET
        resolution=excluded.resolution,note=excluded.note,resolved_by=excluded.resolved_by,resolved_at=datetime('now')`).run(
      session.id, item.asset_id, differenceType, cleanText(item.resolution) || 'confirmed', cleanText(item.note) || null, req.user.id
    );
  }
  audit(req, 'inventory.difference.resolve_bulk', 'inventory_session', session.id, '批量处理盘点差异');
  res.json({ ok: true, differences: inventoryDifferences(session.id) });
});

// Scan / check-in an asset into a session (used by both QR scan page and manual click)
app.post('/api/inventory/:id/scan', (req, res) => {
  // Mobile scanning uses the per-session token; desktop may use a normal JWT.
  const h = req.headers.authorization || '';
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  let authenticatedUser = null;
  if (h === `Bearer agent:${AGENT_SECRET}`) authenticatedUser = { username: 'agent' };
  else if (h.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(h.slice(7), JWT_SECRET);
      authenticatedUser = db.prepare('SELECT id,username,display_name,role FROM users WHERE (id=? OR username=?) AND active=1').get(payload.sub, payload.username || payload.sub);
    } catch {}
  }
  const body = req.body || {};
  if (!authenticatedUser && (!session.scan_token || (body.scan_token || req.query.scan_token) !== session.scan_token)) return res.status(401).json({ error: '需要有效的盘点扫码凭证' });
  const { asset_id, scanned_location, note, scanned_by } = body;
  if (!asset_id) return res.status(400).json({ error: 'asset_id required' });
  if (session.status !== 'open') return res.status(400).json({ error: '盘点已关闭或正在复核' });
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
  recordAssetEvent(asset_id, 'inventory_scan', scanned_by || authenticatedUser?.username || 'mobile',
    [
      '盘点确认',
      scanned_location ? `位置：${scanned_location}` : '',
      note ? `备注：${note}` : ''
    ].filter(Boolean).join(' · '));
  if (authenticatedUser?.id) audit({ ...req, user: authenticatedUser }, 'inventory.scan', 'inventory_session', session.id, `扫码盘点：${asset.hostname}`, { asset_id });
  res.json({ ok: true, hostname: asset.hostname });
});

// ── Reports / CSV Export ──────────────────────────────────────────────────────
function toCSV(rows, cols) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
}

// All assets report
app.get('/api/reports/assets.csv', requirePermission('report:read'), (req, res) => {
  const rows = req.user.role === 'employee'
    ? db.prepare('SELECT * FROM assets WHERE owner_user_id=? OR owner=? OR owner=? ORDER BY hostname').all(req.user.id, req.user.display_name, req.user.username)
    : db.prepare('SELECT * FROM assets ORDER BY hostname').all();
  const cols = ['hostname','asset_type','source','manufacturer','model','serial_number',
    'platform','ip','mac_address','cpu','cpu_cores','ram_total','disk_total','os','os_version',
    'location','department','owner','owner_user_id','asset_tag','lifecycle_status','lifecycle_updated_at',
    'purchase_date','purchase_cost','currency','warranty_expires_at','supplier','invoice_no',
    'useful_life_months','residual_value',
    'ping_enabled','ping_status','last_ping_at','ping_latency_ms','last_seen','created_at'];
  res.set('Content-Type','text/csv; charset=utf-8');
  res.set('Content-Disposition','attachment; filename="assets.csv"');
  res.set('Cache-Control','no-store');
  res.send('\uFEFF' + toCSV(rows, cols));
});

app.get('/api/reports/costs.csv', requirePermission('report:read'), (req, res) => {
  const rows = db.prepare('SELECT hostname,asset_tag,asset_type,department,owner,purchase_date,purchase_cost,currency,useful_life_months,residual_value,warranty_expires_at FROM assets ORDER BY hostname').all()
    .map(asset => ({ ...asset, book_value: bookValue(asset) }));
  const cols = ['hostname','asset_tag','asset_type','department','owner','purchase_date','purchase_cost','currency','useful_life_months','residual_value','book_value','warranty_expires_at'];
  res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="asset-costs.csv"').send('\uFEFF' + toCSV(rows, cols));
});

// Inventory session report
app.get('/api/reports/inventory/:id.csv', requirePermission('report:read'), (req, res) => {
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const rows = db.prepare(`
    SELECT a.hostname, a.asset_type, a.asset_tag, a.department, a.owner, a.ip, a.platform, a.os,
           a.lifecycle_status, r.scanned_location, r.note, r.scanned_by, r.scanned_at,
           a.location as registered_location
    FROM inventory_records r JOIN assets a ON a.id=r.asset_id
    WHERE r.session_id=? ORDER BY r.scanned_at
  `).all(req.params.id);

  // Append un-scanned assets
  const scannedIds = new Set(rows.map(r => r.hostname));
  const all = db.prepare('SELECT hostname,asset_type,asset_tag,department,owner,ip,platform,os,location,lifecycle_status FROM assets').all();
  for (const a of all) {
    if (!scannedIds.has(a.hostname)) {
      rows.push({ ...a, registered_location: a.location,
        scanned_location:'', note:'未盘点', scanned_by:'', scanned_at:'' });
    }
  }
  const cols = ['hostname','asset_type','asset_tag','department','owner','ip','platform','os',
    'lifecycle_status','registered_location','scanned_location','note','scanned_by','scanned_at'];
  res.set('Content-Type','text/csv; charset=utf-8');
  res.set('Cache-Control','no-store');
  const fn = encodeURIComponent(`inventory-${session.name}.csv`);
  res.set('Content-Disposition',`attachment; filename="inventory.csv"; filename*=UTF-8''${fn}`);
  res.send('\uFEFF' + toCSV(rows, cols));
});

// Inventory summary stats
app.get('/api/reports/transactions.csv', requirePermission('report:read'), (req, res) => {
  const rows = db.prepare(`SELECT t.id,t.type,t.status,t.created_at,t.decided_at,t.completed_at,
    a.hostname,a.asset_tag,u.display_name as requester_name,o.display_name as approver_name,
    t.to_department,t.to_location,t.due_at,t.amount,t.notes,t.decision_note
    FROM asset_transactions t JOIN assets a ON a.id=t.asset_id
    LEFT JOIN users u ON u.id=t.requested_by LEFT JOIN users o ON o.id=t.approved_by ORDER BY t.created_at DESC`).all();
  const cols = ['id','type','status','hostname','asset_tag','requester_name','approver_name','to_department','to_location','due_at','amount','notes','decision_note','created_at','decided_at','completed_at'];
  res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="lifecycle-transactions.csv"').send('\uFEFF' + toCSV(rows, cols));
});

app.get('/api/reports/work-orders.csv', requirePermission('report:read'), (req, res) => {
  const rows = db.prepare(`SELECT w.number,w.title,w.type,w.priority,w.status,w.due_at,w.created_at,w.resolved_at,
    a.hostname,requester.display_name as requester_name,assignee.display_name as assignee_name
    FROM work_orders w LEFT JOIN assets a ON a.id=w.asset_id
    LEFT JOIN users requester ON requester.id=w.requester_user_id LEFT JOIN users assignee ON assignee.id=w.assignee_user_id
    ORDER BY w.created_at DESC`).all();
  const cols = ['number','title','type','priority','status','hostname','requester_name','assignee_name','due_at','created_at','resolved_at'];
  res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="work-orders.csv"').send('\uFEFF' + toCSV(rows, cols));
});

app.get('/api/reports/audit.csv', requirePermission('audit:read'), (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC,id DESC').all();
  const cols = ['id','actor_username','action','entity_type','entity_id','summary','metadata','ip','created_at'];
  res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="audit-logs.csv"').send('\uFEFF' + toCSV(rows, cols));
});

app.get('/api/inventory/:id/stats', requirePermission('inventory:read'), (req, res) => {
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const total = db.prepare('SELECT COUNT(*) as c FROM inventory_expected WHERE session_id=?').get(req.params.id).c || db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
  const scanned = db.prepare('SELECT COUNT(*) as c FROM inventory_records WHERE session_id=?').get(req.params.id).c;
  const differences = inventoryDifferences(req.params.id);
  res.json({ total, scanned, missing: Math.max(0, total - scanned), differences: differences.filter(row => !row.resolved), session });
});

app.get('/api/public/inventory/:id', (req, res) => {
  const session = db.prepare('SELECT id,name,status FROM inventory_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: '盘点场次不存在' });
  const assets = db.prepare(`
    SELECT id,hostname,asset_type,ip,location,department,owner,asset_tag,lifecycle_status
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

function runReminderSweep() {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const warrantyAssets = db.prepare(`SELECT id,hostname,warranty_expires_at FROM assets
    WHERE warranty_expires_at IS NOT NULL AND warranty_expires_at>=? AND warranty_expires_at<=?`).all(today, soon);
  for (const asset of warrantyAssets) {
    notifyRole('asset_manager', '保修即将到期', `${asset.hostname} 的保修将在 ${asset.warranty_expires_at} 到期`, 'reminder', 'asset', asset.id, `warranty:${asset.id}:${asset.warranty_expires_at}`);
    notifyRole('admin', '保修即将到期', `${asset.hostname} 的保修将在 ${asset.warranty_expires_at} 到期`, 'reminder', 'asset', asset.id, `warranty:${asset.id}:${asset.warranty_expires_at}:admin`);
  }
  const overdueLoans = db.prepare(`SELECT t.id,t.asset_id,t.requested_by,t.due_at,a.hostname
    FROM asset_transactions t JOIN assets a ON a.id=t.asset_id
    WHERE t.type='loan' AND t.status='approved' AND t.due_at IS NOT NULL AND t.due_at<?`).all(new Date().toISOString());
  for (const loan of overdueLoans) {
    createNotification(loan.requested_by, '借用已逾期', `${loan.hostname} 的借用归还日期已过 ${loan.due_at}`, 'reminder', 'asset_transaction', loan.id, `loan-overdue:${loan.id}`);
    notifyRole('asset_manager', '借用已逾期', `${loan.hostname} 的借用归还日期已过 ${loan.due_at}`, 'reminder', 'asset_transaction', loan.id, `loan-overdue:${loan.id}:manager`);
  }
  const overdueOrders = db.prepare(`SELECT id,number,title,assignee_user_id,due_at FROM work_orders
    WHERE assignee_user_id IS NOT NULL AND due_at IS NOT NULL AND due_at<? AND status NOT IN ('closed','resolved','cancelled')`).all(new Date().toISOString());
  for (const order of overdueOrders) createNotification(order.assignee_user_id, '工单已逾期', `${order.number}：${order.title}`, 'reminder', 'work_order', order.id, `work-overdue:${order.id}`);
}


// Template for bulk import
app.get('/api/template/bulk.csv', requireAuth, (req, res) => {
  const columns = [
    'hostname', 'asset_type', 'manufacturer', 'model', 'serial_number', 'ip',
    'mac_address', 'location', 'department', 'owner', 'asset_tag', 'notes',
    'lifecycle_status'
  ];
  const examples = [
    {
      hostname: '核心交换机', asset_type: 'switch', manufacturer: 'Huawei',
      model: 'CE12800', serial_number: '210233A0ABCDEF', ip: '10.1.1.1',
      mac_address: 'AA:BB:CC:DD:EE:FF', location: '机房 A', department: 'IT 部',
      owner: '张三', asset_tag: 'SW001', notes: '网络核心设备', lifecycle_status: 'in_use'
    },
    {
      hostname: '出口防火墙', asset_type: 'firewall', manufacturer: 'Fortinet',
      model: 'FG-100F', serial_number: 'FGT100F000001', ip: '10.1.1.254',
      mac_address: '', location: '机房 A', department: 'IT 部', owner: '李四',
      asset_tag: 'FW001', notes: '互联网出口', lifecycle_status: 'spare'
    }
  ];
  res.set('Content-Type','text/csv; charset=utf-8');
  const filename = encodeURIComponent('批量导入模板.csv');
  res.set('Content-Disposition',
    `attachment; filename="asset-import-template.csv"; filename*=UTF-8''${filename}`);
  res.send('\uFEFF' + toCSV(examples, columns));
});
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
const initialReminderTimer = setTimeout(() => runReminderSweep(), 2000);
initialReminderTimer.unref();
const pingTimer = setInterval(() => runPingSweep().catch(console.error), PING_INTERVAL_SECONDS * 1000);
pingTimer.unref();
const reminderTimer = setInterval(() => runReminderSweep(), Math.max(60, PING_INTERVAL_SECONDS) * 1000);
reminderTimer.unref();

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  clearTimeout(initialPingTimer);
  clearTimeout(initialReminderTimer);
  clearInterval(pingTimer);
  clearInterval(reminderTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
