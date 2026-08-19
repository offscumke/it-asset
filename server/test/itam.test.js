const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ADMIN_PASSWORD = 'test-admin-password';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, processLogs, child) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming healthy\n${processLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${lastError?.message || 'unknown error'}\n${processLogs()}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 3000);
    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}

async function startServer(t) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'it-asset-itam-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = path.join(tempDir, 'assets.db');
  const uploadDir = path.join(tempDir, 'uploads');
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DB_PATH: dbPath,
      UPLOAD_DIR: uploadDir,
      ADMIN_USER: 'admin',
      ADMIN_PASS: ADMIN_PASSWORD,
      AGENT_SECRET: 'test-agent-secret',
      JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
      PING_INTERVAL_SECONDS: '3600'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const processLogs = () => stdout + stderr;
  const cleanup = async () => {
    await stopProcess(child);
    rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    await waitForHealth(baseUrl, processLogs, child);
  } catch (error) {
    await cleanup();
    throw error;
  }
  t.after(cleanup);
  return { baseUrl };
}

async function request(baseUrl, route, options = {}) {
  const {
    token,
    body,
    parse = 'auto',
    headers: suppliedHeaders,
    ...fetchOptions
  } = options;
  const headers = new Headers(suppliedHeaders);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let requestBody = body;
  const isJsonObject = body && typeof body === 'object' &&
    !Buffer.isBuffer(body) &&
    !(body instanceof ArrayBuffer) &&
    !(body instanceof Blob) &&
    !(body instanceof FormData);
  if (isJsonObject) {
    headers.set('Content-Type', 'application/json');
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${route}`, {
    ...fetchOptions,
    headers,
    body: requestBody
  });
  let data;
  if (parse === 'buffer') {
    data = Buffer.from(await response.arrayBuffer());
  } else if (parse === 'text') {
    data = await response.text();
  } else if ((response.headers.get('content-type') || '').includes('json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    data = await response.text();
  }
  return { status: response.status, headers: response.headers, data };
}

function assertStatus(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data)}`);
}

function resource(data, name) {
  return data?.[name] || data;
}

function userFrom(data) {
  return resource(data, 'user');
}

async function login(baseUrl, username, password, expectedRole) {
  const result = await request(baseUrl, '/api/login', {
    method: 'POST',
    body: { username, password }
  });
  assertStatus(result, 200, `login ${username}`);
  assert.equal(typeof result.data.token, 'string');
  assert.ok(result.data.token.length > 0);
  if (expectedRole) assert.equal(userFrom(result.data).role, expectedRole);
  return result.data;
}

async function adminContext(t) {
  const server = await startServer(t);
  const adminLogin = await login(server.baseUrl, 'admin', ADMIN_PASSWORD);
  return { ...server, adminToken: adminLogin.token };
}

async function createUser(context, user) {
  const result = await request(context.baseUrl, '/api/users', {
    method: 'POST',
    token: context.adminToken,
    body: user
  });
  assertStatus(result, 201, `create user ${user.username}`);
  const saved = userFrom(result.data);
  assert.ok(saved.id, `created user ${user.username} has an id`);
  assert.equal(saved.role, user.role);
  return saved;
}

async function createAsset(context, asset) {
  const result = await request(context.baseUrl, '/api/assets', {
    method: 'POST',
    token: context.adminToken,
    body: {
      asset_type: 'server',
      lifecycle_status: 'in_stock',
      ping_enabled: false,
      ...asset
    }
  });
  assertStatus(result, 201, `create asset ${asset.hostname}`);
  const saved = resource(result.data, 'asset');
  assert.ok(saved.id, `created asset ${asset.hostname} has an id`);
  return saved;
}

function rowsFrom(data, name) {
  if (Array.isArray(data)) return data;
  return data?.[name] || data?.items || data?.rows || [];
}

function rowReferencesAsset(row, assetId) {
  return String(row.asset_id ?? row.id ?? row.asset?.id) === String(assetId);
}

test('admin login returns an admin identity and /api/me confirms it', async t => {
  const { baseUrl } = await startServer(t);
  const loginResult = await login(baseUrl, 'admin', ADMIN_PASSWORD, 'admin');
  const me = await request(baseUrl, '/api/me', { token: loginResult.token });
  assertStatus(me, 200, 'GET /api/me');
  assert.equal(userFrom(me.data).role, 'admin');
  assert.equal(userFrom(me.data).username, 'admin');
});

test('admin creates all roles and auditor cannot create an asset', async t => {
  const context = await adminContext(t);
  await createUser(context, {
    username: 'asset-manager', password: 'manager-password',
    display_name: 'Asset Manager', role: 'asset_manager'
  });
  const auditor = await createUser(context, {
    username: 'auditor', password: 'auditor-password',
    display_name: 'Auditor', role: 'auditor'
  });
  const employee = await createUser(context, {
    username: 'employee', password: 'employee-password',
    display_name: 'Employee', role: 'employee', notes: 'Shanghai office'
  });
  const inactiveEmployee = await createUser(context, {
    username: 'inactive-employee', password: 'employee-password',
    display_name: 'Inactive Employee', role: 'employee', active: false
  });

  await login(context.baseUrl, 'employee', 'employee-password', 'employee');
  const auditorLogin = await login(context.baseUrl, 'auditor', 'auditor-password', 'auditor');
  assert.ok(auditor.id);
  assert.ok(employee.id);
  assert.equal(employee.notes, 'Shanghai office');
  assert.equal(inactiveEmployee.active, false);
  const inactiveLogin = await request(context.baseUrl, '/api/login', {
    method: 'POST', body: { username: 'inactive-employee', password: 'employee-password' }
  });
  assertStatus(inactiveLogin, 401, 'inactive employee login');
  const denied = await request(context.baseUrl, '/api/assets', {
    method: 'POST',
    token: auditorLogin.token,
    body: { hostname: 'auditor-denied-asset', asset_type: 'switch' }
  });
  assertStatus(denied, 403, 'auditor POST /api/assets');
});

test('manual asset financial detail exposes a numeric book value', async t => {
  const context = await adminContext(t);
  const created = await createAsset(context, {
    hostname: 'financial-server',
    asset_type: 'server',
    purchase_cost: 1200,
    purchase_date: '2026-08-01',
    useful_life_months: 36,
    residual_value: 120,
    supplier: 'Example Supplier',
    invoice_no: 'INV-2026-001',
    warranty_expires_at: '2028-08-01'
  });

  const detail = await request(context.baseUrl, `/api/assets/${created.id}`, {
    token: context.adminToken
  });
  assertStatus(detail, 200, 'financial asset detail');
  assert.equal(detail.data.purchase_cost, 1200);
  assert.equal(detail.data.purchase_date, '2026-08-01');
  assert.equal(detail.data.supplier, 'Example Supplier');
  assert.equal(detail.data.invoice_no, 'INV-2026-001');
  assert.equal(typeof detail.data.book_value, 'number');

  const publicDetail = await request(context.baseUrl, `/api/public/assets/${created.id}`);
  assertStatus(publicDetail, 200, 'public financial asset detail');
  assert.equal(Object.hasOwn(publicDetail.data, 'purchase_cost'), false);
  assert.equal(Object.hasOwn(publicDetail.data, 'book_value'), false);
});

test('approved lifecycle assignment updates the asset and audit trail', async t => {
  const context = await adminContext(t);
  const employee = await createUser(context, {
    username: 'lifecycle-employee', password: 'employee-password',
    display_name: 'Lifecycle Employee', role: 'employee'
  });
  const asset = await createAsset(context, { hostname: 'lifecycle-server' });

  const createdRequest = await request(context.baseUrl, `/api/assets/${asset.id}/lifecycle-requests`, {
    method: 'POST',
    token: context.adminToken,
    body: {
      action: 'assign',
      target_user_id: employee.id,
      reason: 'Initial employee assignment'
    }
  });
  assertStatus(createdRequest, 201, 'create lifecycle request');
  const lifecycleRequest = resource(createdRequest.data, 'request');
  assert.ok(lifecycleRequest.id);

  const approved = await request(context.baseUrl, `/api/lifecycle-requests/${lifecycleRequest.id}/approve`, {
    method: 'POST',
    token: context.adminToken,
    body: { decision: 'approved' }
  });
  assertStatus(approved, 200, 'approve lifecycle request');

  const detail = await request(context.baseUrl, `/api/assets/${asset.id}`, {
    token: context.adminToken
  });
  assertStatus(detail, 200, 'assigned asset detail');
  assert.equal(String(detail.data.owner_user_id), String(employee.id));
  assert.equal(detail.data.lifecycle_status, 'in_use');

  const audit = await request(
    context.baseUrl,
    `/api/audit?entity_type=asset&entity_id=${encodeURIComponent(asset.id)}`,
    { token: context.adminToken }
  );
  assertStatus(audit, 200, 'asset audit log');
  const auditRows = rowsFrom(audit.data, 'audit');
  assert.ok(auditRows.some(row => /approve|approved|decision/i.test(JSON.stringify(row))));
});

test('asset attachment can be uploaded, listed, downloaded exactly, and deleted', async t => {
  const context = await adminContext(t);
  const asset = await createAsset(context, { hostname: 'attachment-server' });
  const content = 'ITAM attachment exact content\n';
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), 'evidence.txt');

  const upload = await request(context.baseUrl, `/api/assets/${asset.id}/attachments`, {
    method: 'POST',
    token: context.adminToken,
    body: form
  });
  assertStatus(upload, 201, 'upload asset attachment');
  const attachment = resource(upload.data, 'attachment');
  assert.ok(attachment.id);

  const listed = await request(context.baseUrl, `/api/assets/${asset.id}/attachments`, {
    token: context.adminToken
  });
  assertStatus(listed, 200, 'list asset attachments');
  const attachments = rowsFrom(listed.data, 'attachments');
  assert.ok(attachments.some(item => String(item.id) === String(attachment.id)));

  const downloaded = await request(context.baseUrl, `/api/attachments/${attachment.id}/download`, {
    token: context.adminToken,
    parse: 'buffer'
  });
  assertStatus(downloaded, 200, 'download asset attachment');
  assert.equal(downloaded.data.toString(), content);

  const removed = await request(context.baseUrl, `/api/attachments/${attachment.id}`, {
    method: 'DELETE',
    token: context.adminToken
  });
  assertStatus(removed, 200, 'delete asset attachment');
  const listedAfterDelete = await request(context.baseUrl, `/api/assets/${asset.id}/attachments`, {
    token: context.adminToken
  });
  assertStatus(listedAfterDelete, 200, 'list attachments after delete');
  assert.equal(rowsFrom(listedAfterDelete.data, 'attachments').some(item => String(item.id) === String(attachment.id)), false);
});

test('work order can be assigned, commented on, closed, and generates notifications', async t => {
  const context = await adminContext(t);
  const manager = await createUser(context, {
    username: 'work-manager', password: 'manager-password',
    display_name: 'Work Manager', role: 'asset_manager'
  });
  const asset = await createAsset(context, { hostname: 'work-order-server' });

  const created = await request(context.baseUrl, '/api/work-orders', {
    method: 'POST',
    token: context.adminToken,
    body: {
      title: 'Repair server fan',
      description: 'Replace the failed cooling fan',
      type: 'repair',
      priority: 'high',
      asset_id: asset.id
    }
  });
  assertStatus(created, 201, 'create work order');
  const workOrder = resource(created.data, 'work_order');
  assert.ok(workOrder.id);

  const assigned = await request(context.baseUrl, `/api/work-orders/${workOrder.id}/assign`, {
    method: 'POST',
    token: context.adminToken,
    body: { user_id: manager.id }
  });
  assertStatus(assigned, 200, 'assign work order');

  const comment = await request(context.baseUrl, `/api/work-orders/${workOrder.id}/comments`, {
    method: 'POST',
    token: context.adminToken,
    body: { body: 'Replacement fan ordered.' }
  });
  assertStatus(comment, 201, 'comment on work order');

  const closed = await request(context.baseUrl, `/api/work-orders/${workOrder.id}`, {
    method: 'PATCH',
    token: context.adminToken,
    body: { status: 'closed' }
  });
  assertStatus(closed, 200, 'close work order');
  const closedOrder = resource(closed.data, 'work_order');
  assert.equal(closedOrder.status, 'closed');

  const notifications = await request(context.baseUrl, '/api/notifications', {
    token: context.adminToken
  });
  assertStatus(notifications, 200, 'work-order notifications');
  assert.ok(rowsFrom(notifications.data, 'notifications').some(item => JSON.stringify(item).includes(String(workOrder.id))));
});

test('inventory scan token protects scans and reconciliation can be finalized', async t => {
  const context = await adminContext(t);
  const present = await createAsset(context, {
    hostname: 'inventory-present-server', location: 'Rack A'
  });
  const missing = await createAsset(context, {
    hostname: 'inventory-missing-server', location: 'Rack B'
  });
  const created = await request(context.baseUrl, '/api/inventory', {
    method: 'POST',
    token: context.adminToken,
    body: { name: 'Full ITAM inventory' }
  });
  assertStatus(created, 200, 'create inventory session');
  const session = resource(created.data, 'session');
  assert.ok(session.id);
  assert.equal(typeof session.scan_token, 'string');
  assert.ok(session.scan_token.length > 0);

  const initialSessions = await request(context.baseUrl, '/api/inventory', {
    token: context.adminToken
  });
  assertStatus(initialSessions, 200, 'inventory session list before scanning');
  const initialSession = rowsFrom(initialSessions.data, 'inventory')
    .find(row => row.id === session.id);
  assert.equal(initialSession.expected_count, 2);
  assert.equal(initialSession.scanned_count, 0);

  const unauthenticatedScan = await request(context.baseUrl, `/api/inventory/${session.id}/scan`, {
    method: 'POST',
    body: { asset_id: present.id }
  });
  assert.ok([401, 403].includes(unauthenticatedScan.status),
    `unauthenticated scan must be denied, got ${unauthenticatedScan.status}`);

  const scan = await request(
    context.baseUrl,
    `/api/inventory/${session.id}/scan?scan_token=${encodeURIComponent(session.scan_token)}`,
    {
      method: 'POST',
      body: { asset_id: present.id, scanned_location: 'Rack C', scanned_by: 'Mobile Tester' }
    }
  );
  assertStatus(scan, 200, 'token-protected inventory scan');

  const scannedSessions = await request(context.baseUrl, '/api/inventory', {
    token: context.adminToken
  });
  assertStatus(scannedSessions, 200, 'inventory session list after scanning');
  const scannedSession = rowsFrom(scannedSessions.data, 'inventory')
    .find(row => row.id === session.id);
  assert.equal(scannedSession.expected_count, 2);
  assert.equal(scannedSession.scanned_count, 1);

  const differences = await request(context.baseUrl, `/api/inventory/${session.id}/differences`, {
    token: context.adminToken
  });
  assertStatus(differences, 200, 'inventory differences');
  assert.ok(Array.isArray(differences.data.missing));
  assert.ok(Array.isArray(differences.data.location));
  assert.ok(differences.data.missing.some(row => rowReferencesAsset(row, missing.id)));
  assert.ok(differences.data.location.some(row => rowReferencesAsset(row, present.id)));

  const resolved = await request(context.baseUrl, `/api/inventory/${session.id}/resolutions`, {
    method: 'POST',
    token: context.adminToken,
    body: {
      resolutions: [
        { asset_id: missing.id, difference_type: 'missing', resolution: 'confirmed_missing' },
        { asset_id: present.id, difference_type: 'location', resolution: 'location_verified' }
      ]
    }
  });
  assertStatus(resolved, 200, 'resolve inventory differences');

  const finalized = await request(context.baseUrl, `/api/inventory/${session.id}/finalize`, {
    method: 'POST',
    token: context.adminToken
  });
  assertStatus(finalized, 200, 'finalize inventory');
  const finalizedSession = resource(finalized.data, 'session');
  assert.ok(['closed', 'finalized'].includes(finalizedSession.status) || finalized.data.finalized === true);
});

test('SNMP integration sync records status and never returns plaintext secrets', async t => {
  const context = await adminContext(t);
  const secretRef = 'vault://itam/integrations/snmp-test';
  const created = await request(context.baseUrl, '/api/integrations', {
    method: 'POST',
    token: context.adminToken,
    body: {
      name: 'SNMP test adapter',
      type: 'snmp',
      secret_ref: secretRef,
      notes: 'Datacenter switches',
      config: { host: '192.0.2.10', port: 161, community_ref: secretRef }
    }
  });
  assertStatus(created, 201, 'create SNMP integration');
  const integration = resource(created.data, 'integration');
  assert.ok(integration.id);
  assert.equal(integration.type, 'snmp');
  assert.equal(integration.secret_ref, secretRef);
  assert.equal(integration.notes, 'Datacenter switches');
  for (const field of ['secret', 'password', 'secret_value', 'credential']) {
    assert.equal(Object.hasOwn(integration, field), false, `integration must not expose ${field}`);
  }

  const sync = await request(context.baseUrl, `/api/integrations/${integration.id}/sync`, {
    method: 'POST',
    token: context.adminToken
  });
  assertStatus(sync, 200, 'sync SNMP integration');
  const syncStatus = sync.data.status || sync.data.run?.status;
  assert.ok(['needs_configuration', 'completed'].includes(syncStatus));

  const runs = await request(context.baseUrl, `/api/integrations/${integration.id}/runs`, {
    token: context.adminToken
  });
  assertStatus(runs, 200, 'integration run history');
  const runRows = rowsFrom(runs.data, 'runs');
  assert.ok(runRows.length >= 1);
  for (const row of runRows) {
    assert.equal(Object.hasOwn(row, 'secret'), false);
    assert.equal(Object.hasOwn(row, 'password'), false);
    assert.equal(Object.hasOwn(row, 'secret_value'), false);
  }
});

test('employee access is scoped and cannot read users or global audit', async t => {
  const context = await adminContext(t);
  const employee = await createUser(context, {
    username: 'scoped-employee', password: 'employee-password',
    display_name: 'Scoped Employee', role: 'employee'
  });
  const assigned = await createAsset(context, {
    hostname: 'employee-owned-server', owner_user_id: employee.id
  });
  await createAsset(context, { hostname: 'other-owned-server' });
  const employeeLogin = await login(context.baseUrl, 'scoped-employee', 'employee-password', 'employee');

  const users = await request(context.baseUrl, '/api/users', { token: employeeLogin.token });
  assertStatus(users, 403, 'employee GET /api/users');
  const audit = await request(context.baseUrl, '/api/audit', { token: employeeLogin.token });
  assertStatus(audit, 403, 'employee GET /api/audit');

  const assets = await request(context.baseUrl, '/api/assets', { token: employeeLogin.token });
  assertStatus(assets, 200, 'employee scoped assets');
  const visibleAssets = rowsFrom(assets.data, 'assets');
  assert.equal(visibleAssets.length, 1);
  assert.equal(String(visibleAssets[0].id), String(assigned.id));
});

test('report summary and financial CSV report succeed', async t => {
  const context = await adminContext(t);
  await createAsset(context, {
    hostname: 'report-financial-server',
    purchase_cost: 2400,
    purchase_date: '2026-08-01',
    useful_life_months: 48,
    residual_value: 240
  });

  const summary = await request(context.baseUrl, '/api/reports/summary', {
    token: context.adminToken
  });
  assertStatus(summary, 200, 'report summary');
  const totalAssets = summary.data.total_assets ?? summary.data.asset_count ??
    summary.data.assets?.total ?? summary.data.assets?.count;
  assert.equal(typeof totalAssets, 'number');
  assert.equal(typeof summary.data.warranty_expiring, 'number');
  assert.equal(typeof summary.data.open_work_orders, 'number');

  const csv = await request(context.baseUrl, '/api/reports/costs.csv', {
    token: context.adminToken,
    parse: 'text'
  });
  assertStatus(csv, 200, 'financial CSV report');
  assert.match(csv.headers.get('content-type') || '', /text\/csv/);
  assert.match(csv.data, /purchase_cost/);
  assert.match(csv.data, /book_value/);
  assert.match(csv.data, /report-financial-server/);
});
