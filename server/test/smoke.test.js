const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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

async function waitForHealth(baseUrl, processLogs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy\n${processLogs()}`);
}

test('asset, QR, Ping and inventory workflows', async t => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'it-asset-test-'));
  const pingBinary = path.join(tempDir, 'ping-ok');
  writeFileSync(pingBinary, '#!/bin/sh\necho "64 bytes: icmp_seq=1 ttl=64 time=0.123 ms"\n');
  chmodSync(pingBinary, 0o755);

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'assets.db'),
      ADMIN_USER: 'admin',
      ADMIN_PASS: 'test-admin-password',
      AGENT_SECRET: 'test-agent-secret',
      JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
      PING_BINARY: pingBinary,
      PING_INTERVAL_SECONDS: '3600'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, () => stdout + stderr);

  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-admin-password' })
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const manualComputer = await fetch(`${baseUrl}/api/assets`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ hostname: 'manual-pc', asset_type: 'computer' })
  });
  assert.equal(manualComputer.status, 400);

  const createManual = await fetch(`${baseUrl}/api/assets`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      hostname: 'edge-firewall-01',
      asset_type: 'firewall',
      manufacturer: 'Example',
      model: 'FW-1000',
      serial_number: 'SN-001',
      ip: '127.0.0.1',
      mac_address: '00:11:22:33:44:55',
      department: 'IT',
      owner: 'Alice',
      location: 'Server Room',
      asset_tag: 'NET-001',
      notes: 'Primary edge',
      ping_enabled: true
    })
  });
  assert.equal(createManual.status, 201);
  const manual = await createManual.json();
  assert.equal(manual.source, 'manual');
  assert.equal(manual.asset_type, 'firewall');
  assert.equal(manual.owner, 'Alice');

  const invalidIp = await fetch(`${baseUrl}/api/assets`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ hostname: 'invalid-ip', asset_type: 'switch', ip: '127.0.0.1;echo bad' })
  });
  assert.equal(invalidIp.status, 400);

  const checkin = await fetch(`${baseUrl}/api/checkin`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer agent:test-agent-secret',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      hostname: 'agent-laptop-01',
      platform: 'darwin',
      ip: '10.0.0.10',
      mac_address: 'AA:BB:CC:DD:EE:FF',
      cpu: 'Test CPU',
      cpu_cores: 8,
      ram_total: 17179869184,
      disk_total: 512000000000,
      os: 'macOS',
      os_version: '15.0',
      software: [{ name: 'Browser', version: '1.0' }]
    })
  });
  assert.equal(checkin.status, 200);
  const agentId = (await checkin.json()).id;

  const assignAgent = await fetch(`${baseUrl}/api/assets/${agentId}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ department: 'Engineering', owner: 'Bob', asset_tag: 'PC-001' })
  });
  assert.equal(assignAgent.status, 200);
  const assigned = await assignAgent.json();
  assert.equal(assigned.asset_type, 'computer');
  assert.equal(assigned.source, 'agent');
  assert.equal(assigned.owner, 'Bob');

  const alterAgentIp = await fetch(`${baseUrl}/api/assets/${agentId}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ ip: '10.0.0.11' })
  });
  assert.equal(alterAgentIp.status, 400);

  const duplicateName = await fetch(`${baseUrl}/api/assets/${manual.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ hostname: 'agent-laptop-01' })
  });
  assert.equal(duplicateName.status, 409);

  const ping = await fetch(`${baseUrl}/api/assets/${manual.id}/ping`, {
    method: 'POST',
    headers: authHeaders
  });
  assert.equal(ping.status, 200);
  const pinged = await ping.json();
  assert.equal(pinged.online_status, 'online');
  assert.equal(pinged.ping_latency_ms, 0.123);

  const qr = await fetch(`${baseUrl}/api/assets/${manual.id}/qr`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /^image\/png/);
  const qrBytes = Buffer.from(await qr.arrayBuffer());
  assert.equal(qrBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(qrBytes.length > 500);

  const publicDetail = await fetch(`${baseUrl}/api/public/assets/${manual.id}`);
  assert.equal(publicDetail.status, 200);
  const publicAsset = await publicDetail.json();
  assert.equal(publicAsset.hostname, 'edge-firewall-01');
  assert.equal(publicAsset.online_status, 'online');
  assert.equal(Object.hasOwn(publicAsset, 'cpu'), false);

  const createInventory = await fetch(`${baseUrl}/api/inventory`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Smoke Inventory' })
  });
  assert.equal(createInventory.status, 200);
  const sessionId = (await createInventory.json()).id;

  const publicInventory = await fetch(`${baseUrl}/api/public/inventory/${sessionId}`);
  assert.equal(publicInventory.status, 200);
  const inventoryData = await publicInventory.json();
  assert.equal(inventoryData.stats.total, 2);
  assert.equal(inventoryData.assets.length, 2);

  const scan = await fetch(`${baseUrl}/api/inventory/${sessionId}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset_id: manual.id, scanned_by: 'Tester' })
  });
  assert.equal(scan.status, 200);

  const close = await fetch(`${baseUrl}/api/inventory/${sessionId}/close`, {
    method: 'PATCH',
    headers: authHeaders
  });
  assert.equal(close.status, 200);
  assert.equal((await close.json()).already_closed, false);

  const closeAgain = await fetch(`${baseUrl}/api/inventory/${sessionId}/close`, {
    method: 'PATCH',
    headers: authHeaders
  });
  assert.equal(closeAgain.status, 200);
  assert.equal((await closeAgain.json()).already_closed, true);

  const scanClosed = await fetch(`${baseUrl}/api/inventory/${sessionId}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset_id: agentId })
  });
  assert.equal(scanClosed.status, 400);

  const csv = await fetch(`${baseUrl}/api/reports/assets.csv`, { headers: authHeaders });
  assert.equal(csv.status, 200);
  const csvText = await csv.text();
  assert.match(csvText, /hostname,asset_type,source/);
  assert.match(csvText, /edge-firewall-01/);
  assert.ok(csvText.length > 200);

  const remove = await fetch(`${baseUrl}/api/assets/${manual.id}`, {
    method: 'DELETE',
    headers: authHeaders
  });
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).deleted, 1);

  const missing = await fetch(`${baseUrl}/api/assets/${manual.id}`, { headers: authHeaders });
  assert.equal(missing.status, 404);
});
