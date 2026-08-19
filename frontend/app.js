/* global BarcodeDetector */
(function () {
  'use strict';

  const state = {
    token: localStorage.getItem('it_token') || '',
    user: null,
    permissions: new Set(),
    page: 'dashboard',
    assets: [],
    users: [],
    transactions: [],
    inventory: [],
    workOrders: [],
    notifications: [],
    integrations: [],
    inventoryTokens: Object.create(null),
    assetFilters: { query: '', type: '', lifecycle: '', department: '', owner: '' },
    toastTimer: null,
  };

  const ASSET_TYPES = {
    computer: ['电脑', 'PC', 'blue'],
    server: ['服务器', 'SR', 'violet'],
    switch: ['交换机', 'SW', 'teal'],
    firewall: ['防火墙', 'FW', 'red'],
    router: ['路由器', 'RT', 'teal'],
    wireless_ap: ['无线 AP', 'AP', 'teal'],
    printer: ['打印机', 'PR', 'amber'],
    storage: ['存储', 'ST', 'violet'],
    other: ['其他', 'OT', 'neutral'],
  };
  const LIFECYCLE = {
    in_use: '在用', in_stock: '库存', spare: '备用', repair: '维修', loaned: '借出',
    retired: '已报废', recycled: '已回收', lost: '丢失', disabled: '已禁用',
  };
  const TRANSACTION_TYPES = {
    purchase: '采购', stock_in: '入库', assign: '分配', return: '归还', loan: '借出',
    loan_return: '借出归还', repair: '送修', repair_complete: '维修完成', transfer: '调拨',
    retire: '报废', recycle: '回收', disable: '禁用', enable: '启用',
  };
  const WORK_ORDER_TYPES = { request: '服务请求', incident: '故障事件', repair: '维修任务' };
  const WORK_ORDER_STATUS = { open: '待处理', in_progress: '处理中', pending: '待确认', resolved: '已解决', closed: '已关闭', cancelled: '已取消' };
  const ROLE_LABELS = { admin: '管理员', asset_manager: '资产管理员', auditor: '审计员', employee: '员工' };
  const NAV = [
    ['dashboard', '仪表盘', 'Dashboard'],
    ['assets', '资产', 'Assets'],
    ['lifecycle', '生命周期', 'Lifecycle'],
    ['inventory', '盘点', 'Inventory'],
    ['workorders', '工单', 'Work Orders'],
    ['notifications', '通知', 'Notifications'],
    ['reports', '报告 / 审计', 'Reports / Audit'],
    ['users', '用户', 'Users'],
    ['integrations', '集成', 'Integrations'],
  ];
  const ROLE_NAV = {
    admin: ['dashboard', 'assets', 'lifecycle', 'inventory', 'workorders', 'notifications', 'reports', 'users', 'integrations'],
    asset_manager: ['dashboard', 'assets', 'lifecycle', 'inventory', 'workorders', 'notifications', 'reports'],
    auditor: ['dashboard', 'assets', 'inventory', 'reports'],
    employee: ['dashboard', 'assets', 'lifecycle', 'workorders', 'notifications'],
  };

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function attr(value) { return esc(value); }

  function fmtDate(value) {
    if (!value) return '—';
    const raw = String(value);
    const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN');
  }

  function fmtMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }) : '—';
  }

  function fmtBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    return `${(bytes / 1e6).toFixed(0)} MB`;
  }

  function collection(data, keys) {
    if (Array.isArray(data)) return data;
    for (const key of keys || []) if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.rows)) return data.rows;
    return [];
  }

  function first(data, keys, fallback) {
    for (const key of keys) if (data && data[key] != null) return data[key];
    return fallback;
  }

  function typeMeta(type) { return ASSET_TYPES[type] || ASSET_TYPES.other; }
  function lifecycleLabel(status) { return LIFECYCLE[status] || status || '未设置'; }
  function transactionLabel(type) { return TRANSACTION_TYPES[type] || type || '生命周期变更'; }
  function workTypeLabel(type) { return WORK_ORDER_TYPES[type] || type || '工单'; }
  function workStatusLabel(status) { return WORK_ORDER_STATUS[status] || status || '未设置'; }

  function badge(label, className) { return `<span class="badge ${esc(className || 'neutral')}">${esc(label)}</span>`; }

  function actionButton(action, label, data, className, title) {
    const attrs = Object.entries(data || {}).map(([key, value]) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${attr(value)}"`).join(' ');
    return `<button type="button" class="button button-small ${className || 'button-quiet'}" data-action="${attr(action)}" ${attrs}${title ? ` title="${attr(title)}"` : ''}>${label}</button>`;
  }

  function iconButton(action, glyph, data, className, title) {
    const attrs = Object.entries(data || {}).map(([key, value]) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${attr(value)}"`).join(' ');
    return `<button type="button" class="icon-button ${className || ''}" data-action="${attr(action)}" ${attrs} title="${attr(title || glyph)}" aria-label="${attr(title || glyph)}">${glyph}</button>`;
  }

  function showToast(message, error) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
  }

  function decodeToken(token) {
    try {
      const part = token.split('.')[1];
      const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.exp && payload.exp * 1000 <= Date.now()) return null;
      return payload;
    } catch (_) { return null; }
  }

  function flattenPermissions(value, prefix, target) {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => { if (typeof item === 'string') target.add(item.toLowerCase()); });
      return;
    }
    if (typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => {
        const next = prefix ? `${prefix}.${key}` : key;
        if (item === true) target.add(next.toLowerCase());
        else if (typeof item === 'string' && item.toLowerCase() === 'true') target.add(next.toLowerCase());
        else flattenPermissions(item, next, target);
      });
    }
  }

  function role() { return String(state.user?.role || state.user?.role_name || 'admin').toLowerCase(); }
  function currentUserName() { return state.user?.display_name || state.user?.name || state.user?.username || state.user?.email || '当前用户'; }
  function hasExplicitPermission(names) {
    if (!state.permissions.size) return false;
    return names.some((name) => {
      const variants = [name, name.replace('.', ':'), name.replace('.', '_'), name.replace('.', '-')].map((item) => item.toLowerCase());
      return variants.some((variant) => state.permissions.has(variant)) || state.permissions.has('*') || state.permissions.has('all');
    });
  }

  function hasBackendPermission(...names) {
    if (!state.permissions.size) return false;
    return names.some((name) => state.permissions.has(name) || state.permissions.has('*') || state.permissions.has('all'));
  }

  function can(capability) {
    if (state.permissions.size) {
      const explicit = {
        'assets.read': ['asset:read', 'asset:*'],
        'assets.write': ['asset:write', 'asset:*'],
        'assets.delete': ['asset:delete', 'asset:*'],
        'lifecycle.read': ['lifecycle:read', 'lifecycle:*'],
        'lifecycle.request': ['lifecycle:request', 'lifecycle:write', 'lifecycle:*'],
        'lifecycle.approve': ['lifecycle:write', 'lifecycle:*'],
        'inventory.read': ['inventory:read', 'inventory:*'],
        'inventory.write': ['inventory:write', 'inventory:*'],
        'workorders.read': ['work:read', 'work:*'],
        'workorders.write': ['work:write', 'work:*'],
        'notifications.read': ['notification:read', 'notification:*'],
        'notifications.write': ['notification:read', 'notification:*'],
        'reports.read': ['report:read', 'report:*'],
        'audit.read': ['audit:read', 'audit:*'],
        'users.read': ['user:manage', 'user:read', 'user:*'],
        'users.write': ['user:manage', 'user:*'],
        'integrations.read': ['integration:read', 'integration:manage', 'integration:*'],
        'integrations.write': ['integration:manage', 'integration:*'],
      };
      return hasBackendPermission(...(explicit[capability] || [])) || hasExplicitPermission([capability]);
    }
    const permissions = {
      'assets.read': ['admin', 'asset_manager', 'auditor', 'employee'],
      'assets.write': ['admin', 'asset_manager'],
      'assets.delete': ['admin', 'asset_manager'],
      'lifecycle.read': ['admin', 'asset_manager', 'auditor', 'employee'],
      'lifecycle.request': ['admin', 'asset_manager', 'employee'],
      'lifecycle.approve': ['admin', 'asset_manager'],
      'inventory.read': ['admin', 'asset_manager', 'auditor'],
      'inventory.write': ['admin', 'asset_manager'],
      'workorders.read': ['admin', 'asset_manager', 'employee'],
      'workorders.write': ['admin', 'asset_manager', 'employee'],
      'notifications.read': ['admin', 'asset_manager', 'employee'],
      'notifications.write': ['admin', 'asset_manager', 'employee'],
      'reports.read': ['admin', 'asset_manager', 'auditor'],
      'audit.read': ['admin', 'auditor'],
      'users.read': ['admin'],
      'users.write': ['admin'],
      'integrations.read': ['admin'],
      'integrations.write': ['admin'],
    };
    return (permissions[capability] || []).includes(role());
  }

  function visiblePages() {
    const rolePages = ROLE_NAV[role()] || ROLE_NAV.employee;
    return NAV.filter(([id]) => rolePages.includes(id) && (id === 'dashboard' || can(`${id === 'workorders' ? 'workorders' : id}.read`) || id === 'lifecycle' && can('lifecycle.read')));
  }

  function setUser(user, permissions) {
    state.user = user || { username: decodeToken(state.token)?.sub || 'admin', role: 'admin' };
    state.permissions = new Set();
    flattenPermissions(permissions, '', state.permissions);
    const caption = document.getElementById('role-caption');
    const badgeNode = document.getElementById('user-badge');
    if (caption) caption.textContent = ROLE_LABELS[role()] || role();
    if (badgeNode) badgeNode.textContent = `${currentUserName()} · ${ROLE_LABELS[role()] || role()}`;
    renderNav();
  }

  function renderNav() {
    const nav = document.getElementById('primary-nav');
    if (!nav) return;
    nav.innerHTML = visiblePages().map(([id, label, en]) => {
      const roleLabel = role() === 'employee' && id === 'assets' ? '我的资产' : role() === 'employee' && id === 'lifecycle' ? '生命周期请求' : role() === 'employee' && id === 'workorders' ? '我的工单' : label;
      return `<button type="button" class="${state.page === id ? 'active' : ''}" data-action="navigate" data-page="${attr(id)}" title="${attr(en)}">${esc(roleLabel)}</button>`;
    }).join('');
  }

  async function request(path, options) {
    const opts = { cache: 'no-store', ...(options || {}) };
    const headers = new Headers(opts.headers || {});
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    if (opts.body && !(opts.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    opts.headers = headers;
    const response = await fetch(path, opts);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('json') ? await response.json().catch(() => ({})) : await response.text();
    if (response.status === 401) {
      logout(false);
      throw new ApiError('登录已失效，请重新登录', 401, data);
    }
    if (!response.ok) {
      const message = typeof data === 'string' ? data : data?.error || data?.message || `请求失败（${response.status}）`;
      throw new ApiError(message, response.status, data);
    }
    return data;
  }

  async function optional(path, fallback) {
    try { return await request(path); } catch (_) { return fallback; }
  }

  function pageShell(id, kicker, title, description, actions) {
    state.page = id;
    renderNav();
    document.getElementById('main-content').innerHTML = `
      <div class="page-heading">
        <div><span class="eyebrow">${esc(kicker)}</span><h1>${esc(title)}</h1>${description ? `<p class="page-description">${esc(description)}</p>` : ''}</div>
        <div class="page-actions">${actions || ''}</div>
      </div>
      <div id="page-body"><div class="loading-state">正在加载…</div></div>`;
    document.getElementById('main-content').focus({ preventScroll: true });
  }

  function pageError(message) { return `<div class="error-state">${esc(message)}<div class="button-row" style="justify-content:center;margin-top:12px">${actionButton('reload-page', '重新加载', {}, 'button-quiet')}</div></div>`; }

  function setPageBody(html) { const node = document.getElementById('page-body'); if (node) node.innerHTML = html; }

  function openModal(title, content, kicker, wide) {
    const modal = document.getElementById('modal');
    modal.querySelector('.modal').classList.toggle('modal-wide', Boolean(wide));
    document.getElementById('modal-kicker').textContent = kicker || '工作区';
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = content;
    modal.hidden = false;
  }

  function closeModal() { document.getElementById('modal').hidden = true; }

  function formField(label, id, value, type, options, full, help) {
    let control;
    if (type === 'select') control = `<select class="form-select" id="${attr(id)}">${options || ''}</select>`;
    else if (type === 'textarea') control = `<textarea class="form-textarea" id="${attr(id)}">${esc(value || '')}</textarea>`;
    else control = `<input class="form-input" id="${attr(id)}" type="${attr(type || 'text')}" value="${attr(value || '')}">`;
    return `<div class="form-field${full ? ' full' : ''}"><label class="form-label" for="${attr(id)}">${esc(label)}</label>${control}${help ? `<div class="form-help">${esc(help)}</div>` : ''}</div>`;
  }

  function optionList(items, selected, emptyLabel) {
    return `${emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : ''}${items.map(([value, label]) => `<option value="${attr(value)}" ${String(value) === String(selected || '') ? 'selected' : ''}>${esc(label)}</option>`).join('')}`;
  }

  function assetOptions(selected, includeEmpty) {
    return optionList(state.assets.map((asset) => [asset.id, asset.hostname || asset.asset_tag || asset.id]), selected, includeEmpty ? '选择资产' : '');
  }

  async function bootstrap() {
    if (!state.token) return false;
    const payload = decodeToken(state.token);
    if (!payload) { logout(false); return false; }
    try {
      const me = await request('/api/me');
      setUser(me.user || me, me.permissions);
    } catch (error) {
      // The pre-ITAM server has no /api/me; retain its admin session for compatibility.
      if (error.status !== 404) { logout(false); return false; }
      setUser({ username: payload.sub || 'admin', role: payload.role || 'admin' }, []);
    }
    document.getElementById('login-page').hidden = true;
    document.getElementById('app').hidden = false;
    await navigate(state.page, false);
    loadUnreadCount();
    return true;
  }

  async function doLogin(event) {
    event.preventDefault();
    const errorNode = document.getElementById('login-error');
    errorNode.textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await request('/api/login', { method: 'POST', body: { username: document.getElementById('login-user').value.trim(), password: document.getElementById('login-pass').value } });
      if (!data?.token) throw new Error('登录响应缺少 token');
      state.token = data.token;
      localStorage.setItem('it_token', state.token);
      const payload = decodeToken(state.token) || {};
      state.page = decodeURIComponent(location.hash.slice(1) || 'dashboard');
      setUser(data.user || { username: payload.sub || 'admin', role: payload.role || 'admin' }, data.permissions || []);
      document.getElementById('login-page').hidden = true;
      document.getElementById('app').hidden = false;
      await bootstrap();
    } catch (error) {
      errorNode.textContent = error.message || '无法连接服务器';
    } finally { button.disabled = false; }
  }

  function logout(showMessage) {
    state.token = '';
    state.user = null;
    state.permissions.clear();
    localStorage.removeItem('it_token');
    document.getElementById('app').hidden = true;
    document.getElementById('login-page').hidden = false;
    document.getElementById('login-pass').value = '';
    closeModal();
    if (showMessage) showToast('已退出登录');
  }

  async function navigate(page, persist) {
    const allowed = visiblePages().map(([id]) => id);
    const next = allowed.includes(page) ? page : allowed[0] || 'dashboard';
    if (persist !== false) history.replaceState(null, '', `#${encodeURIComponent(next)}`);
    const loaders = { dashboard: loadDashboard, assets: loadAssets, lifecycle: loadLifecycle, inventory: loadInventory, workorders: loadWorkOrders, notifications: loadNotifications, reports: loadReports, users: loadUsers, integrations: loadIntegrations };
    await (loaders[next] || loadDashboard)();
  }

  async function loadUnreadCount() {
    if (!can('notifications.read')) return;
    const data = await optional('/api/notifications', []);
    const rows = collection(data, ['notifications']);
    const count = rows.filter((item) => !item.read_at && !item.is_read && item.read !== true).length;
    const node = document.getElementById('notification-count');
    if (node) { node.textContent = count > 99 ? '99+' : String(count); node.hidden = count === 0; }
  }

  async function loadDashboard() {
    pageShell('dashboard', 'Dashboard', '仪表盘', '今天需要处理的资产、生命周期和运营事项。');
    try {
      const data = await request('/api/dashboard');
      renderDashboard(data || {});
    } catch (error) {
      if (error.status === 404) {
        const assets = await optional('/api/assets', []);
        state.assets = collection(assets, ['assets']);
        renderDashboard({ assets: state.assets });
      } else setPageBody(pageError(error.message));
    }
  }

  function renderDashboard(data) {
    const assetRows = collection(data, ['assets', 'recent_assets']);
    const pending = collection(data, ['pending_items', 'transactions', 'lifecycle_requests']);
    const work = collection(data, ['recent_work_orders', 'open_work_orders']);
    const notices = collection(data, ['notifications', 'recent_notifications']);
    const stats = data.stats || data.summary || data;
    const total = first(stats, ['total_assets', 'asset_count', 'total'], first(stats.assets || {}, ['total'], assetRows.length || state.assets.length));
    const online = first(stats, ['online_assets', 'online'], first(stats.assets || {}, ['online'], assetRows.filter((asset) => asset.online_status === 'online').length));
    const due = first(stats, ['pending_transactions', 'pending_lifecycle', 'due_count'], typeof data.pending_transactions === 'number' ? data.pending_transactions : pending.length);
    const open = first(stats, ['open_work_orders', 'work_order_count'], Object.values(stats.work_orders || {}).reduce((sum, value) => sum + Number(value || 0), work.length));
    setPageBody(`
      <section class="metric-grid">
        <div class="metric metric-teal"><span class="metric-icon">AS</span><div><div class="metric-label">资产总数</div><div class="metric-value">${esc(total)}</div></div></div>
        <div class="metric metric-green"><span class="metric-icon">ON</span><div><div class="metric-label">在线 / 正常</div><div class="metric-value">${esc(online)}</div></div></div>
        <div class="metric metric-amber"><span class="metric-icon">LC</span><div><div class="metric-label">待审批</div><div class="metric-value">${esc(due)}</div></div></div>
        <div class="metric metric-blue"><span class="metric-icon">WO</span><div><div class="metric-label">处理中工单</div><div class="metric-value">${esc(open)}</div></div></div>
      </section>
      <section class="layout-two">
        <div class="panel"><div class="panel-header"><h2>最近资产活动</h2>${actionButton('navigate', '查看资产', { page: 'assets' }, 'button-quiet')}</div><div class="panel-body flush">
          ${assetRows.length ? `<ul class="list">${assetRows.slice(0, 8).map((asset) => `<li class="list-item"><div class="list-main"><div class="list-title">${esc(asset.hostname || asset.name || asset.asset_tag || '未命名资产')}</div><div class="list-meta">${esc(typeMeta(asset.asset_type)[0])} · ${esc(asset.owner || asset.department || '未分配')} · ${fmtDate(asset.updated_at || asset.last_seen || asset.created_at)}</div></div>${badge(lifecycleLabel(asset.lifecycle_status), asset.lifecycle_status || 'neutral')}</li>`).join('')}</ul>` : '<div class="empty-state">暂无资产活动</div>'}
        </div></div>
        <div class="panel"><div class="panel-header"><h2>待处理事项</h2>${actionButton('navigate', '打开通知', { page: 'notifications' }, 'button-quiet')}</div><div class="panel-body">
          ${pending.length || work.length || notices.length ? `<ul class="list">${pending.slice(0, 3).map((item) => `<li class="list-item"><div class="list-main"><div class="list-title">${esc(transactionLabel(item.type))} · ${esc(item.asset_name || item.hostname || item.asset_id || '生命周期请求')}</div><div class="list-meta">${fmtDate(item.created_at || item.requested_at)}</div></div>${badge(item.status || 'pending', item.status || 'pending')}</li>`).join('')}${work.slice(0, 3).map((item) => `<li class="list-item"><div class="list-main"><div class="list-title">${esc(item.title || item.subject || '工单')}</div><div class="list-meta">${esc(workTypeLabel(item.type))} · ${fmtDate(item.due_at || item.created_at)}</div></div>${badge(workStatusLabel(item.status), item.status || 'info')}</li>`).join('')}${notices.slice(0, 2).map((item) => `<li class="list-item"><div class="list-main"><div class="list-title">${esc(item.title || item.message || '通知')}</div><div class="list-meta">${fmtDate(item.created_at)}</div></div>${item.read_at || item.read ? badge('已读', 'neutral') : badge('未读', 'warn')}</li>`).join('')}</ul>` : '<div class="empty-state compact">当前没有待处理事项</div>'}
        </div></div>
      </section>`);
  }

  async function loadAssets() {
    pageShell('assets', 'Assets', role() === 'employee' ? '我的资产' : '资产', '资产主数据、健康状态、归属和财务信息。', `${can('assets.write') ? actionButton('asset-form', '新增资产', {}, 'button-primary') + actionButton('bulk-import', '批量导入', {}, 'button-secondary') : ''}${can('reports.read') ? actionButton('download', '导出 CSV', { url: '/api/reports/assets.csv', filename: 'assets.csv' }, 'button-quiet') : ''}${iconButton('reload-page', '↻', {}, '', '刷新')}`);
    try {
      const data = await request('/api/assets');
      state.assets = collection(data, ['assets']);
      renderAssets();
    } catch (error) { setPageBody(pageError(error.message)); }
  }

  function renderAssets() {
    const values = state.assetFilters;
    const departments = [...new Set(state.assets.map((asset) => asset.department).filter(Boolean))].sort();
    const owners = [...new Set(state.assets.map((asset) => asset.owner).filter(Boolean))].sort();
    const matches = state.assets.filter((asset) => {
      const text = [asset.hostname, asset.ip, asset.asset_tag, asset.department, asset.owner, asset.location, asset.manufacturer, asset.model, asset.serial_number, lifecycleLabel(asset.lifecycle_status)].filter(Boolean).join(' ').toLowerCase();
      return (!values.query || text.includes(values.query.toLowerCase())) && (!values.type || asset.asset_type === values.type) && (!values.lifecycle || asset.lifecycle_status === values.lifecycle) && (!values.department || asset.department === values.department) && (!values.owner || asset.owner === values.owner);
    });
    const typeOpts = optionList(Object.entries(ASSET_TYPES).map(([value, meta]) => [value, meta[0]]), values.type, '全部类型');
    const lifecycleOpts = optionList(Object.entries(LIFECYCLE).map(([value, label]) => [value, label]), values.lifecycle, '全部状态');
    const deptOpts = optionList(departments.map((item) => [item, item]), values.department, '全部部门');
    const ownerOpts = optionList(owners.map((item) => [item, item]), values.owner, '全部责任人');
    setPageBody(`
      <div class="page-toolbar"><label class="search-field"><span aria-hidden="true">⌕</span><input data-action="asset-search" value="${attr(values.query)}" placeholder="搜索名称、IP、序列号、标签或责任人" aria-label="搜索资产"></label><div class="filter-row"><select data-action="asset-filter" data-filter="type" aria-label="按类型筛选">${typeOpts}</select><select data-action="asset-filter" data-filter="lifecycle" aria-label="按状态筛选">${lifecycleOpts}</select><select data-action="asset-filter" data-filter="department" aria-label="按部门筛选">${deptOpts}</select><select data-action="asset-filter" data-filter="owner" aria-label="按责任人筛选">${ownerOpts}</select></div><div class="toolbar-actions"><span class="small muted">${matches.length} / ${state.assets.length} 条</span></div></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>资产</th><th>归属 / 位置</th><th>状态</th><th>健康</th><th>财务</th><th>操作</th></tr></thead><tbody>${matches.length ? matches.map(assetRow).join('') : '<tr><td colspan="6"><div class="empty-state">没有匹配的资产</div></td></tr>'}</tbody></table></div>`);
  }

  function assetRow(asset) {
    const meta = typeMeta(asset.asset_type);
    const health = asset.online_status === 'online' ? '<span class="status-line online">在线</span>' : asset.online_status === 'offline' ? '<span class="status-line offline">离线</span>' : '<span class="status-line">未检测</span>';
    const financial = asset.book_value != null ? fmtMoney(asset.book_value) : asset.purchase_cost != null ? fmtMoney(asset.purchase_cost) : '—';
    let actions = actionButton('asset-detail', '查看', { id: asset.id }, 'button-secondary');
    actions += can('assets.write') ? actionButton('asset-form', '编辑', { id: asset.id }, 'button-quiet') : '';
    actions += can('lifecycle.request') ? actionButton('transaction-form', '变更', { assetId: asset.id }, 'button-violet') : '';
    actions += iconButton('asset-qr', '▦', { id: asset.id }, '', '二维码');
    if (asset.source === 'manual' && asset.ip && can('assets.write')) actions += iconButton('asset-ping', '⌁', { id: asset.id }, '', 'Ping');
    if (asset.source === 'agent' && asset.ip) actions += iconButton('asset-vnc', '↗', { ip: asset.ip, port: asset.vnc_port || 5900 }, '', 'VNC');
    actions += can('assets.delete') ? iconButton('asset-delete', '×', { id: asset.id }, 'danger', '删除') : '';
    return `<tr><td><span class="type-mark ${esc(meta[2])}">${esc(meta[1])}</span><span class="asset-primary">${esc(asset.hostname || asset.name || '未命名')}</span><div class="asset-secondary">${esc(meta[0])} · ${esc(asset.asset_tag || asset.serial_number || asset.id || '')}</div></td><td>${esc(asset.owner || asset.department || '未分配')}<div class="asset-secondary">${esc(asset.location || '位置未设置')}</div></td><td>${badge(lifecycleLabel(asset.lifecycle_status), asset.lifecycle_status || 'neutral')}<div class="asset-secondary">${esc(asset.source === 'agent' ? 'Agent' : '手工')}</div></td><td>${health}<div class="asset-secondary">${fmtDate(asset.last_seen || asset.last_ping_at)}</div></td><td>${esc(financial)}<div class="asset-secondary">${asset.warranty_expires_at || asset.warranty_end_at || asset.warranty_end ? `保修至 ${esc(fmtDate(asset.warranty_expires_at || asset.warranty_end_at || asset.warranty_end))}` : '无财务数据'}</div></td><td><div class="action-group">${actions}</div></td></tr>`;
  }

  async function showAssetDetail(id) {
    try {
      const asset = await request(`/api/assets/${encodeURIComponent(id)}`);
      const meta = typeMeta(asset.asset_type);
      const events = collection(asset, ['events', 'history']);
      const relations = collection(asset, ['relations']);
      const technical = asset.source === 'agent' ? `<div class="detail-item"><div class="detail-key">CPU</div><div class="detail-value">${esc(asset.cpu || '—')} · ${esc(asset.cpu_cores || '—')} 核</div></div><div class="detail-item"><div class="detail-key">内存 / 磁盘</div><div class="detail-value">${esc(fmtBytes(asset.ram_total))} / ${esc(fmtBytes(asset.disk_total))}</div></div>` : '';
      const attachmentSection = `<div class="modal-section"><h3>附件</h3><div id="asset-attachments"><div class="loading-state">正在加载附件…</div></div>${can('assets.write') ? `<form data-form="attachment" data-entity-type="asset" data-entity-id="${attr(id)}" class="button-row" style="margin-top:10px"><input class="form-input" name="file" type="file" required><button class="button button-secondary" type="submit">上传附件</button></form>` : ''}</div>`;
      const relationSection = `<div class="modal-section"><h3>关联资产</h3>${relations.length ? `<ul class="list">${relations.map((relation) => `<li class="list-item"><div class="list-main"><div class="list-title">${esc(relation.related_asset_name || relation.hostname || relation.related_asset_id)}</div><div class="list-meta">${esc(relation.relation_type || '关联')}</div></div>${can('assets.write') ? iconButton('relation-delete', '×', { assetId: id, relationId: relation.id || relation.relation_id }, 'danger', '删除关联') : ''}</li>`).join('')}</ul>` : '<div class="empty-state compact">暂无关联资产</div>'}${can('assets.write') ? actionButton('relation-form', '添加关联', { id }, 'button-quiet') : ''}</div>`;
      openModal(asset.hostname || '资产详情', `<div class="detail-grid"><div class="detail-item"><div class="detail-key">资产类型</div><div class="detail-value">${esc(meta[0])}</div></div><div class="detail-item"><div class="detail-key">来源</div><div class="detail-value">${esc(asset.source === 'agent' ? 'Agent 自动采集' : '手工录入')}</div></div><div class="detail-item"><div class="detail-key">序列号 / 资产标签</div><div class="detail-value">${esc(asset.serial_number || '—')} / ${esc(asset.asset_tag || '—')}</div></div><div class="detail-item"><div class="detail-key">厂商 / 型号</div><div class="detail-value">${esc(asset.manufacturer || '—')} / ${esc(asset.model || '—')}</div></div><div class="detail-item"><div class="detail-key">IP / MAC</div><div class="detail-value">${esc(asset.ip || '—')} / ${esc(asset.mac_address || '—')}</div></div><div class="detail-item"><div class="detail-key">部门 / 责任人</div><div class="detail-value">${esc(asset.department || '—')} / ${esc(asset.owner || '—')}</div></div><div class="detail-item"><div class="detail-key">位置</div><div class="detail-value">${esc(asset.location || '—')}</div></div><div class="detail-item"><div class="detail-key">生命周期</div><div class="detail-value">${badge(lifecycleLabel(asset.lifecycle_status), asset.lifecycle_status || 'neutral')}</div></div>${technical}<div class="detail-item"><div class="detail-key">采购成本 / 账面价值</div><div class="detail-value">${esc(fmtMoney(asset.purchase_cost))} / ${esc(fmtMoney(asset.book_value))}</div></div><div class="detail-item full"><div class="detail-key">备注</div><div class="detail-value">${esc(asset.notes || '—')}</div></div></div>${events.length ? `<div class="modal-section"><h3>资产事件</h3><ul class="timeline">${events.map((event) => `<li><div class="timeline-title">${esc(event.action || event.title || '变更')}</div><div class="timeline-meta">${esc(event.detail || event.summary || '')} · ${esc(event.actor || '系统')} · ${fmtDate(event.created_at || event.occurred_at)}</div></li>`).join('')}</ul></div>` : ''}${relationSection}${attachmentSection}`, 'Assets · 资产详情', true);
      loadAttachments('asset', id, 'asset-attachments');
    } catch (error) { showToast(error.message, true); }
  }

  function assetFormOptions(asset) {
    const meta = asset ? typeMeta(asset.asset_type) : null;
    const types = Object.entries(ASSET_TYPES).filter(([value]) => asset || value !== 'computer').map(([value, item]) => [value, item[0]]);
    return `<div class="form-grid">${formField('资产名称', 'asset-hostname', asset?.hostname, 'text', null, false)}${formField('资产类型', 'asset-type', asset?.asset_type || 'other', 'select', optionList(types, asset?.asset_type || 'other'), false)}${formField('生命周期状态', 'asset-lifecycle', asset?.lifecycle_status || 'in_use', 'select', optionList(Object.entries(LIFECYCLE).map(([value, label]) => [value, label]), asset?.lifecycle_status || 'in_use'), false)}${formField('厂商', 'asset-manufacturer', asset?.manufacturer, 'text', null, false)}${formField('型号', 'asset-model', asset?.model, 'text', null, false)}${formField('序列号', 'asset-serial', asset?.serial_number, 'text', null, false)}${formField('资产标签', 'asset-tag', asset?.asset_tag, 'text', null, false)}${formField('IP 地址', 'asset-ip', asset?.ip, 'text', null, false)}${formField('MAC 地址', 'asset-mac', asset?.mac_address, 'text', null, false)}${formField('部门', 'asset-department', asset?.department, 'text', null, false)}${formField('责任人', 'asset-owner', asset?.owner_user_id, 'select', optionList(state.users.map((user) => [user.id || user.user_id || user.username, user.display_name || user.name || user.username]), asset?.owner_user_id, '未分配'), false)}${formField('位置', 'asset-location', asset?.location, 'text', null, false)}${formField('采购日期', 'asset-purchase-date', asset?.purchase_date, 'date', null, false)}${formField('采购成本', 'asset-purchase-cost', asset?.purchase_cost, 'number', null, false)}${formField('供应商', 'asset-supplier', asset?.supplier, 'text', null, false)}${formField('发票号', 'asset-invoice', asset?.invoice_no, 'text', null, false)}${formField('保修结束', 'asset-warranty-end', asset?.warranty_expires_at || asset?.warranty_end_at || asset?.warranty_end, 'date', null, false)}${formField('使用寿命（月）', 'asset-useful-life', asset?.useful_life_months, 'number', null, false)}${formField('残值', 'asset-residual-value', asset?.residual_value, 'number', null, false)}${formField('备注', 'asset-notes', asset?.notes, 'textarea', null, true)}</div><div class="button-row" style="justify-content:flex-end;margin-top:18px"><button type="button" class="button button-quiet" data-action="close-modal">取消</button><button type="button" class="button button-primary" data-action="save-asset" data-id="${attr(asset?.id || '')}">${asset ? '保存变更' : '创建资产'}</button></div>`;
  }

  async function openAssetForm(id) {
    if (!can('assets.write')) return;
    if (!state.users.length) state.users = collection(await optional('/api/users/directory', []), ['users']);
    const asset = id ? state.assets.find((item) => item.id === id) || await optional(`/api/assets/${encodeURIComponent(id)}`, null) : null;
    openModal(asset ? `编辑 ${asset.hostname}` : '新增资产', assetFormOptions(asset), 'Assets · 资产主数据');
  }

  async function saveAsset(id) {
    if (!can('assets.write')) return;
    const value = (field) => document.getElementById(`asset-${field}`)?.value.trim() || null;
    const body = { hostname: value('hostname'), lifecycle_status: value('lifecycle'), manufacturer: value('manufacturer'), model: value('model'), serial_number: value('serial'), asset_tag: value('tag'), department: value('department'), owner_user_id: value('owner'), location: value('location'), purchase_date: document.getElementById('asset-purchase-date')?.value || null, purchase_cost: document.getElementById('asset-purchase-cost')?.value || null, supplier: document.getElementById('asset-supplier')?.value.trim() || null, invoice_no: document.getElementById('asset-invoice')?.value.trim() || null, warranty_expires_at: document.getElementById('asset-warranty-end')?.value || null, useful_life_months: document.getElementById('asset-useful-life')?.value || null, residual_value: document.getElementById('asset-residual-value')?.value || null, notes: value('notes') };
    const existing = state.assets.find((asset) => asset.id === id);
    if (!id || existing?.source === 'manual') Object.assign(body, { asset_type: value('type'), ip: value('ip'), mac_address: value('mac') });
    if (!body.hostname) { showToast('资产名称不能为空', true); return; }
    try {
      await request(id ? `/api/assets/${encodeURIComponent(id)}` : '/api/assets', { method: id ? 'PATCH' : 'POST', body });
      closeModal(); showToast(id ? '资产信息已保存' : '资产已创建'); await loadAssets();
    } catch (error) { showToast(error.message, true); }
  }

  async function deleteAsset(id) {
    if (!can('assets.delete')) return;
    const asset = state.assets.find((item) => item.id === id);
    if (!asset || !window.confirm(`删除资产“${asset.hostname || id}”？`)) return;
    try { await request(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast('资产已删除'); await loadAssets(); }
    catch (error) { showToast(error.message, true); }
  }

  async function pingAsset(id) {
    try { const data = await request(`/api/assets/${encodeURIComponent(id)}/ping`, { method: 'POST' }); showToast(data.online_status === 'online' ? '资产在线' : '资产离线', data.online_status !== 'online'); await loadAssets(); }
    catch (error) { showToast(error.message, true); }
  }

  function launchVnc(ip, port) { window.location.href = `vnc://${ip}:${port || 5900}`; }

  function showQr(id) {
    const asset = state.assets.find((item) => item.id === id);
    const detailUrl = `${location.origin}/asset?id=${encodeURIComponent(id)}`;
    openModal(asset?.hostname || '资产二维码', `<div class="qr-preview"><img src="/api/assets/${encodeURIComponent(id)}/qr" alt="${attr(asset?.hostname || '资产')} QR Code"></div><div class="button-row" style="justify-content:center">${actionButton('open-url', '打开只读详情', { url: detailUrl }, 'button-primary')}${actionButton('open-url', '打开二维码图片', { url: `/api/assets/${encodeURIComponent(id)}/qr` }, 'button-quiet')}</div>`, 'Assets · 只读二维码');
  }

  function parseCsv(text) {
    const rows = []; let row = []; let field = ''; let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index]; const next = source[index + 1];
      if (char === '"' && quoted && next === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { row.push(field); field = ''; }
      else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && next === '\n') index += 1; row.push(field); if (row.some((item) => item.trim())) rows.push(row); row = []; field = ''; }
      else field += char;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function openBulkImport() {
    if (!can('assets.write')) return;
    openModal('批量导入资产', `<div class="form-help" style="margin-bottom:12px">使用 CSV 表头映射资产字段。现有 Agent 资产不会被批量覆盖。</div><div class="button-row"><label class="button button-secondary">选择 CSV 文件<input id="bulk-file" type="file" accept=".csv,text/csv" hidden></label>${actionButton('download', '下载模板', { url: '/api/template/bulk.csv', filename: 'bulk-assets.csv' }, 'button-quiet')}</div><div id="bulk-preview" class="empty-state">尚未选择文件</div><div class="button-row" style="justify-content:flex-end;margin-top:14px">${actionButton('close-modal', '取消', {}, 'button-quiet')}<button type="button" class="button button-primary" id="bulk-submit" data-action="submit-bulk" disabled>导入</button></div>`, 'Assets · 批量导入', true);
  }

  async function previewBulk(file) {
    const rows = parseCsv(await file.text());
    const preview = document.getElementById('bulk-preview');
    if (!rows.length) { preview.textContent = 'CSV 没有可用数据'; return; }
    const headers = rows[0].map((item) => item.trim());
    const items = rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || '']))).filter((item) => Object.values(item).some(Boolean));
    window.__bulkAssets = items;
    const invalid = items.filter((item) => !item.hostname || !item.asset_type);
    preview.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.slice(0, 8).map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${items.slice(0, 8).map((item) => `<tr>${headers.slice(0, 8).map((header) => `<td>${esc(item[header])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="form-help">共 ${items.length} 条${invalid.length ? `，${invalid.length} 条缺少资产名称或类型` : ''}</div>`;
    const button = document.getElementById('bulk-submit'); if (button) button.disabled = !items.length || invalid.length > 0;
  }

  async function submitBulk() {
    if (!can('assets.write') || !window.__bulkAssets?.length) return;
    try { const data = await request('/api/assets/bulk', { method: 'POST', body: { assets: window.__bulkAssets } }); closeModal(); showToast(`批量导入完成：新增 ${data.created || 0}，更新 ${data.updated || 0}`); await loadAssets(); }
    catch (error) { showToast(error.message, true); }
  }

  async function loadLifecycle() {
    pageShell('lifecycle', 'Lifecycle', role() === 'employee' ? '生命周期请求' : '生命周期', '可追溯的采购、分配、借用、维修和退役请求。', can('lifecycle.request') ? actionButton('transaction-form', '新建请求', {}, 'button-primary') : '');
    try { state.transactions = collection(await request('/api/transactions'), ['transactions']); renderLifecycle(); }
    catch (error) { if (error.status === 404) { state.transactions = []; renderLifecycle(); } else setPageBody(pageError(error.message)); }
  }

  function renderLifecycle() {
    const rows = state.transactions;
    setPageBody(`<div class="panel"><div class="panel-header"><h2>${role() === 'employee' ? '我的请求' : '请求与生命周期台账'}</h2><span class="small muted">${rows.length} 条记录</span></div><div class="panel-body flush"><div class="table-wrap" style="border:0;border-radius:0"><table class="data-table"><thead><tr><th>请求</th><th>资产</th><th>去向 / 位置</th><th>状态</th><th>金额</th><th>时间</th><th>操作</th></tr></thead><tbody>${rows.length ? rows.map((item) => { const status = item.status || 'pending'; const decision = can('lifecycle.approve') && ['pending', 'submitted'].includes(status) ? `${actionButton('transaction-decision', '批准', { id: item.id, decision: 'approve' }, 'button-primary')}${actionButton('transaction-decision', '拒绝', { id: item.id, decision: 'reject' }, 'button-danger')}` : ''; return `<tr><td><div class="asset-primary">${esc(transactionLabel(item.type))}</div><div class="asset-secondary">${esc(item.requester_name || item.requested_by || '—')}</div></td><td>${esc(item.asset_name || item.hostname || item.asset_id || '—')}</td><td>${esc(item.to_owner_name || item.to_department || item.to_location || '—')}</td><td>${badge(item.status || 'pending', status)}</td><td>${esc(fmtMoney(item.amount))}</td><td>${fmtDate(item.created_at || item.requested_at || item.due_at)}</td><td><div class="action-group">${decision || '<span class="small subtle">只读</span>'}</div></td></tr>`; }).join('') : '<tr><td colspan="7"><div class="empty-state">暂无生命周期请求</div></td></tr>'}</tbody></table></div></div></div>`);
  }

  async function openTransactionForm(assetId) {
    if (!can('lifecycle.request')) return;
    if (!state.assets.length) state.assets = collection(await optional('/api/assets', []), ['assets']);
    if (!state.users.length && can('users.read')) state.users = collection(await optional('/api/users', []), ['users']);
    if (!state.users.length) state.users = collection(await optional('/api/users/directory', []), ['users']);
    const userOptions = optionList(state.users.map((user) => [user.id || user.user_id || user.username, user.display_name || user.name || user.username]), '', '不指定责任人');
    const typeOptions = optionList(Object.entries(TRANSACTION_TYPES).map(([value, label]) => [value, label]), 'assign', '选择变更类型');
    openModal('新建生命周期请求', `<div class="form-grid">${formField('资产', 'tx-asset', assetId, 'select', assetOptions(assetId, true), false)}${formField('变更类型', 'tx-type', 'assign', 'select', typeOptions, false)}${formField('接收人', 'tx-owner', '', 'select', userOptions, false)}${formField('部门', 'tx-department', '', 'text', null, false)}${formField('位置', 'tx-location', '', 'text', null, false)}${formField('截止时间', 'tx-due', '', 'datetime-local', null, false)}${formField('金额', 'tx-amount', '', 'number', null, false)}${formField('备注', 'tx-notes', '', 'textarea', null, true)}</div><div class="button-row" style="justify-content:flex-end;margin-top:18px">${actionButton('close-modal', '取消', {}, 'button-quiet')}<button type="button" class="button button-primary" data-action="save-transaction">提交请求</button></div>`, 'Lifecycle · 请求');
  }

  async function saveTransaction() {
    try { await request('/api/transactions', { method: 'POST', body: { asset_id: document.getElementById('tx-asset').value, type: document.getElementById('tx-type').value, to_owner_user_id: document.getElementById('tx-owner').value || null, to_department: document.getElementById('tx-department').value || null, to_location: document.getElementById('tx-location').value || null, due_at: document.getElementById('tx-due').value || null, amount: document.getElementById('tx-amount').value || null, notes: document.getElementById('tx-notes').value || null } }); closeModal(); showToast('生命周期请求已提交'); await loadLifecycle(); }
    catch (error) { showToast(error.message, true); }
  }

  async function decideTransaction(id, decision) {
    if (!can('lifecycle.approve')) return;
    try { await request(`/api/transactions/${encodeURIComponent(id)}/decision`, { method: 'PATCH', body: { decision } }); showToast(decision === 'approve' ? '请求已批准' : '请求已拒绝'); await loadLifecycle(); }
    catch (error) { showToast(error.message, true); }
  }

  async function loadInventory() {
    pageShell('inventory', 'Inventory', '盘点', '创建盘点快照、追踪扫码进度并处理差异。', can('inventory.write') ? actionButton('inventory-form', '新建盘点', {}, 'button-primary') : '');
    try { state.inventory = collection(await request('/api/inventory'), ['inventory']); renderInventory(); }
    catch (error) { setPageBody(pageError(error.message)); }
  }

  function renderInventory() {
    const rows = state.inventory;
    setPageBody(`<div class="panel"><div class="panel-header"><h2>盘点场次</h2><span class="small muted">${rows.length} 场</span></div><div class="panel-body flush"><div class="table-wrap" style="border:0;border-radius:0"><table class="data-table"><thead><tr><th>场次</th><th>状态</th><th>快照资产</th><th>已盘点</th><th>创建人</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${rows.length ? rows.map((session) => `<tr><td><div class="asset-primary">${esc(session.name || session.title || session.id)}</div><div class="asset-secondary">${esc(session.id)}</div></td><td>${badge(session.status === 'closed' || session.status === 'finalized' ? '已结束' : '进行中', session.status === 'closed' || session.status === 'finalized' ? 'closed' : 'open')}</td><td>${esc(first(session, ['expected_count', 'total', 'asset_count'], '—'))}</td><td>${esc(first(session, ['scanned_count', 'scanned'], '—'))}</td><td>${esc(session.created_by_name || session.created_by || '—')}</td><td>${fmtDate(session.created_at)}</td><td><div class="action-group">${actionButton('inventory-detail', '进度', { id: session.id }, 'button-secondary')}${session.status !== 'closed' && session.status !== 'finalized' && can('inventory.write') ? actionButton('inventory-finalize', '结束', { id: session.id }, 'button-warn') : ''}${can('reports.read') ? iconButton('download', '⇩', { url: `/api/reports/inventory/${encodeURIComponent(session.id)}.csv`, filename: `inventory-${session.name || session.id}.csv` }, '', '导出') : ''}</div></td></tr>`).join('') : '<tr><td colspan="7"><div class="empty-state">暂无盘点场次</div></td></tr>'}</tbody></table></div></div></div>`);
  }

  function openInventoryForm() {
    if (!can('inventory.write')) return;
    openModal('新建盘点场次', `<div class="form-grid">${formField('场次名称', 'inventory-name', '', 'text', null, true, '创建后会冻结当前资产范围。')}</div><div class="button-row" style="justify-content:flex-end;margin-top:18px">${actionButton('close-modal', '取消', {}, 'button-quiet')}<button type="button" class="button button-primary" data-action="save-inventory">创建</button></div>`, 'Inventory · 新建场次');
  }

  async function saveInventory() {
    const name = document.getElementById('inventory-name').value.trim();
    if (!name) { showToast('请输入场次名称', true); return; }
    try { const data = await request('/api/inventory', { method: 'POST', body: { name } }); if (data?.id && data.scan_token) state.inventoryTokens[data.id] = data.scan_token; closeModal(); showToast('盘点场次已创建'); await loadInventory(); }
    catch (error) { showToast(error.message, true); }
  }

  async function inventoryDetail(id) {
    try {
      const [session, stats, records, differences] = await Promise.all([Promise.resolve(state.inventory.find((item) => item.id === id) || { id }), optional(`/api/inventory/${encodeURIComponent(id)}/stats`, {}), optional(`/api/inventory/${encodeURIComponent(id)}/records`, []), optional(`/api/inventory/${encodeURIComponent(id)}/differences`, [])]);
      const rows = collection(records, ['records']);
      const diffs = collection(differences, ['differences']);
      const total = first(stats, ['total', 'expected_count'], first(session, ['total', 'expected_count'], '—'));
      const scanned = first(stats, ['scanned', 'scanned_count'], first(session, ['scanned', 'scanned_count'], '—'));
      const missing = first(stats, ['missing', 'missing_count'], '—');
      const token = state.inventoryTokens[id] || session.scan_token;
      openModal(session.name || '盘点详情', `<section class="metric-grid"><div class="metric metric-blue"><div><div class="metric-label">快照总数</div><div class="metric-value">${esc(total)}</div></div></div><div class="metric metric-green"><div><div class="metric-label">已盘点</div><div class="metric-value">${esc(scanned)}</div></div></div><div class="metric metric-amber"><div><div class="metric-label">未盘点</div><div class="metric-value">${esc(missing)}</div></div></div></section><div class="button-row">${can('inventory.write') && session.status !== 'closed' && session.status !== 'finalized' ? actionButton('copy-scan-link', '复制扫码链接', { id, token: token || '' }, 'button-orange') : ''}${can('reports.read') ? actionButton('download', '导出盘点报表', { url: `/api/reports/inventory/${encodeURIComponent(id)}.csv`, filename: `inventory-${session.name || id}.csv` }, 'button-quiet') : ''}</div><div class="modal-section"><h3>差异 (${diffs.length})</h3><div id="inventory-differences">${renderDifferences(diffs, id)}</div></div><div class="modal-section"><h3>已盘点记录 (${rows.length})</h3>${rows.length ? `<ul class="list">${rows.map((record) => `<li class="list-item"><div class="list-main"><div class="list-title">${esc(record.hostname || record.asset_name || record.asset_id)}</div><div class="list-meta">${esc(record.scanned_location || record.asset_location || '位置未填')} · ${esc(record.scanned_by || '—')} · ${fmtDate(record.scanned_at)}</div></div>${badge('已盘点', 'completed')}</li>`).join('')}</ul>` : '<div class="empty-state compact">暂无扫码记录</div>'}</div>`, 'Inventory · 盘点详情', true);
    } catch (error) { showToast(error.message, true); }
  }

  function renderDifferences(differences, sessionId) {
    if (!differences.length) return '<div class="empty-state compact">暂无未解决差异</div>';
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>资产</th><th>差异类型</th><th>登记值</th><th>实际值</th><th>操作</th></tr></thead><tbody>${differences.map((item) => `<tr><td>${esc(item.asset_name || item.hostname || item.asset_id)}</td><td>${badge(item.difference_type || item.type || '差异', 'warn')}</td><td>${esc(item.expected_value || item.expected_location || item.expected_owner || '—')}</td><td>${esc(item.actual_value || item.actual_location || item.actual_owner || '—')}</td><td>${can('inventory.write') && !item.resolved_at && !item.resolved ? actionButton('difference-form', '处理', { sessionId, assetId: item.asset_id, differenceType: item.difference_type || item.type }, 'button-secondary') : badge('已处理', 'completed')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  async function resolveDifferenceForm(sessionId, assetId, differenceType) {
    openModal('处理盘点差异', `<div class="form-grid">${formField('差异类型', 'difference-type', differenceType, 'text', null, true)}${formField('处理决定', 'difference-resolution', 'accept_actual', 'select', optionList([['accept_actual', '接受实际值'], ['keep_expected', '保留登记值'], ['mark_unresolved', '暂不处理']], 'accept_actual'), true)}${formField('备注', 'difference-notes', '', 'textarea', null, true)}</div><div class="button-row" style="justify-content:flex-end;margin-top:18px">${actionButton('close-modal', '取消', {}, 'button-quiet')}<button type="button" class="button button-primary" data-action="save-difference" data-session-id="${attr(sessionId)}" data-asset-id="${attr(assetId)}">保存决定</button></div>`, 'Inventory · 差异处理');
  }

  async function resolveDifference(sessionId, assetId) {
    try { await request(`/api/inventory/${encodeURIComponent(sessionId)}/differences/${encodeURIComponent(assetId)}/resolve`, { method: 'PATCH', body: { difference_type: document.getElementById('difference-type').value, resolution: document.getElementById('difference-resolution').value, note: document.getElementById('difference-notes').value || null } }); closeModal(); showToast('差异处理已保存'); await inventoryDetail(sessionId); }
    catch (error) { showToast(error.message, true); }
  }

  async function finalizeInventory(id) {
    if (!can('inventory.write') || !window.confirm('确认结束此盘点？未处理差异可能阻止最终结案。')) return;
    try { await request(`/api/inventory/${encodeURIComponent(id)}/finalize`, { method: 'PATCH' }); showToast('盘点已结束'); await loadInventory(); }
    catch (error) {
      if (error.status === 404) {
        try { await request(`/api/inventory/${encodeURIComponent(id)}/close`, { method: 'PATCH' }); showToast('盘点已结束'); await loadInventory(); }
        catch (fallbackError) { showToast(fallbackError.message, true); }
      } else showToast(error.message, true);
    }
  }

  async function copyScanLink(id, token) {
    const query = new URLSearchParams({ session: id }); if (token) query.set('token', token);
    const url = `${location.origin}/scan?${query.toString()}`;
    try { await navigator.clipboard.writeText(url); showToast('扫码链接已复制'); } catch (_) { window.prompt('复制扫码链接', url); }
  }

  async function loadWorkOrders() {
    pageShell('workorders', 'Work Orders', role() === 'employee' ? '我的工单' : '工单', '服务请求、故障事件和维修任务的处理队列。', can('workorders.write') ? actionButton('work-order-form', '新建工单', {}, 'button-primary') : '');
    try { state.workOrders = collection(await request('/api/work-orders'), ['work_orders']); renderWorkOrders(); }
    catch (error) { if (error.status === 404) { state.workOrders = []; renderWorkOrders(); } else setPageBody(pageError(error.message)); }
  }

  function renderWorkOrders() {
    const rows = state.workOrders;
    setPageBody(`<div class="panel"><div class="panel-header"><h2>${role() === 'employee' ? '我的工单' : '运营工单队列'}</h2><span class="small muted">${rows.length} 条</span></div><div class="panel-body flush"><div class="table-wrap" style="border:0;border-radius:0"><table class="data-table"><thead><tr><th>工单</th><th>类型 / 优先级</th><th>资产</th><th>负责人</th><th>状态</th><th>截止时间</th><th>操作</th></tr></thead><tbody>${rows.length ? rows.map((item) => `<tr><td><div class="asset-primary">${esc(item.title || item.subject || '未命名工单')}</div><div class="asset-secondary">${esc(item.ticket_no || item.id || '')}</div></td><td>${esc(workTypeLabel(item.type))}<div class="asset-secondary">${esc(item.priority || 'normal')}</div></td><td>${esc(item.asset_name || item.hostname || item.asset_id || '—')}</td><td>${esc(item.assignee_name || item.assigned_to_name || item.assigned_to || '未分配')}</td><td>${badge(workStatusLabel(item.status), item.status || 'info')}</td><td>${fmtDate(item.due_at)}</td><td>${actionButton('work-order-detail', '查看', { id: item.id }, 'button-secondary')}</td></tr>`).join('') : '<tr><td colspan="7"><div class="empty-state">暂无工单</div></td></tr>'}</tbody></table></div></div></div>`);
  }

  async function openWorkOrderForm() {
    if (!can('workorders.write')) return;
    if (!state.assets.length) state.assets = collection(await optional('/api/assets', []), ['assets']);
    if (!state.users.length) state.users = collection(await optional('/api/users/directory', []), ['users']);
    openModal('新建工单', `<div class="form-grid">${formField('标题', 'wo-title', '', 'text', null, true)}${formField('类型', 'wo-type', 'request', 'select', optionList(Object.entries(WORK_ORDER_TYPES).map(([value, label]) => [value, label]), 'request'), false)}${formField('优先级', 'wo-priority', 'normal', 'select', optionList([['low', '低'], ['normal', '普通'], ['high', '高'], ['urgent', '紧急']], 'normal'), false)}${formField('关联资产', 'wo-asset', '', 'select', assetOptions('', true), false)}${formField('负责人', 'wo-assignee', '', 'select', optionList(state.users.map((user) => [user.id || user.user_id || user.username, user.display_name || user.name || user.username]), '', '未分配'), false)}${formField('截止时间', 'wo-due', '', 'datetime-local', null, false)}${formField('描述', 'wo-description', '', 'textarea', null, true)}</div><div class="button-row" style="justify-content:flex-end;margin-top:18px">${actionButton('close-modal', '取消', {}, 'button-quiet')}<button type="button" class="button button-primary" data-action="save-work-order">创建工单</button></div>`, 'Work Orders · 新建');
  }

  async function saveWorkOrder() {
    try { await request('/api/work-orders', { method: 'POST', body: { title: document.getElementById('wo-title').value.trim(), type: document.getElementById('wo-type').value, priority: document.getElementById('wo-priority').value, asset_id: document.getElementById('wo-asset').value || null, assignee_user_id: document.getElementById('wo-assignee').value || null, due_at: document.getElementById('wo-due').value || null, description: document.getElementById('wo-description').value || null } }); closeModal(); showToast('工单已创建'); await loadWorkOrders(); }
    catch (error) { showToast(error.message, true); }
  }

  async function workOrderDetail(id) {
    try {
      const detail = await request(`/api/work-orders/${encodeURIComponent(id)}`);
      const comments = collection(detail, ['comments', 'work_order_comments']);
      const statuses = Object.entries(WORK_ORDER_STATUS).map(([value, label]) => [value, label]);
      openModal(detail.title || detail.subject || '工单详情', `<div class="detail-grid"><div class="detail-item"><div class="detail-key">类型</div><div class="detail-value">${esc(workTypeLabel(detail.type))}</div></div><div class="detail-item"><div class="detail-key">优先级 / 状态</div><div class="detail-value">${esc(detail.priority || 'normal')} · ${badge(workStatusLabel(detail.status), detail.status || 'info')}</div></div><div class="detail-item"><div class="detail-key">关联资产</div><div class="detail-value">${esc(detail.asset_name || detail.hostname || detail.asset_id || '—')}</div></div><div class="detail-item"><div class="detail-key">负责人</div><div class="detail-value">${esc(detail.assignee_name || detail.assigned_to_name || detail.assigned_to || '未分配')}</div></div><div class="detail-item"><div class="detail-key">截止时间</div><div class="detail-value">${esc(fmtDate(detail.due_at))}</div></div><div class="detail-item"><div class="detail-key">创建时间</div><div class="detail-value">${esc(fmtDate(detail.created_at))}</div></div><div class="detail-item full"><div class="detail-key">描述</div><div class="detail-value">${esc(detail.description || detail.notes || '—')}</div></div></div>${can('workorders.write') ? `<div class="modal-section"><h3>更新状态</h3><div class="button-row"><select class="form-select" id="wo-status" style="width:auto;min-width:150px">${optionList(statuses, detail.status)}</select>${actionButton('save-work-status', '保存状态', { id }, 'button-primary')}</div></div>` : ''}<div class="modal-section"><h3>评论 (${comments.length})</h3>${comments.length ? `<ul class="timeline">${comments.map((comment) => `<li><div class="timeline-title">${esc(comment.author_name || comment.author || '用户')}</div><div class="timeline-meta">${esc(comment.body || comment.content || comment.comment || '')} · ${fmtDate(comment.created_at)}</div></li>`).join('')}</ul>` : '<div class="empty-state compact">暂无评论</div>'}${can('workorders.write') ? `<div class="button-row" style="margin-top:12px"><textarea class="form-textarea" id="wo-comment" placeholder="添加处理记录"></textarea>${actionButton('add-work-comment', '发表', { id }, 'button-secondary')}</div>` : ''}</div><div class="modal-section"><h3>附件</h3><div id="work-order-attachments"><div class="loading-state">正在加载附件…</div></div>${can('workorders.write') ? `<form data-form="attachment" data-entity-type="work_order" data-entity-id="${attr(id)}" class="button-row" style="margin-top:10px"><input class="form-input" name="file" type="file" required><button class="button button-secondary" type="submit">上传附件</button></form>` : ''}</div>`, 'Work Orders · 工单详情', true);
      loadAttachments('work_order', id, 'work-order-attachments');
    } catch (error) { showToast(error.message, true); }
  }

  async function saveWorkStatus(id) {
    try { await request(`/api/work-orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: document.getElementById('wo-status').value } }); showToast('工单状态已更新'); await workOrderDetail(id); await loadWorkOrders(); }
    catch (error) { showToast(error.message, true); }
  }

  async function addWorkComment(id) {
    const body = document.getElementById('wo-comment').value.trim(); if (!body) return;
    try { await request(`/api/work-orders/${encodeURIComponent(id)}/comments`, { method: 'POST', body: { body } }); showToast('评论已添加'); await workOrderDetail(id); }
    catch (error) { showToast(error.message, true); }
  }

  async function loadNotifications() {
    pageShell('notifications', 'Notifications', '通知', '审批、工单、保修和借用提醒。', can('notifications.write') ? actionButton('read-all', '全部标为已读', {}, 'button-quiet') : '');
    try { state.notifications = collection(await request('/api/notifications'), ['notifications']); renderNotifications(); }
    catch (error) { setPageBody(pageError(error.message)); }
  }

  function renderNotifications() {
    const rows = state.notifications;
    setPageBody(`<div class="panel"><div class="panel-header"><h2>我的通知</h2><span class="small muted">${rows.filter((item) => !item.read_at && !item.read).length} 条未读</span></div><div class="panel-body flush"><ul class="list">${rows.length ? rows.map((item) => `<li class="list-item"><div class="list-main"><div class="list-title">${esc(item.title || item.subject || '系统通知')}</div><div class="list-meta">${esc(item.message || item.body || '')} · ${fmtDate(item.created_at)}</div></div><div class="action-group">${item.read_at || item.read ? badge('已读', 'neutral') : `${badge('未读', 'warn')}${can('notifications.write') ? actionButton('read-notification', '标记已读', { id: item.id }, 'button-quiet') : ''}`}</div></li>`).join('') : '<li class="empty-state">暂无通知</li>'}</ul></div></div>`);
  }

  async function readNotification(id) {
    try { await request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH' }); await loadNotifications(); loadUnreadCount(); }
    catch (error) { showToast(error.message, true); }
  }

  async function readAllNotifications() {
    try { await request('/api/notifications/read-all', { method: 'POST' }); showToast('通知已全部标记为已读'); await loadNotifications(); loadUnreadCount(); }
    catch (error) { showToast(error.message, true); }
  }

  async function loadReports() {
    pageShell('reports', 'Reports / Audit', '报告与审计', '资产、生命周期、财务、工单和系统操作证据。');
    try { const [summary, audit] = await Promise.all([optional('/api/reports/summary', {}), can('audit.read') ? optional('/api/audit', []) : Promise.resolve([])]); renderReports(summary, collection(audit, ['audit', 'logs'])); }
    catch (error) { setPageBody(pageError(error.message)); }
  }

  function renderReports(summary, audit) {
    const stats = summary.stats || summary.summary || summary;
    const total = first(stats, ['total_assets', 'asset_count', 'total'], state.assets.length);
    const book = first(stats, ['total_book_value', 'book_value', 'total_value'], null);
    const warranty = first(stats, ['warranty_expiring', 'warranty_due', 'warranty_soon'], '—');
    const work = first(stats, ['open_work_orders', 'work_orders'], '—');
    const auditPanel = can('audit.read') ? `<div class="panel" style="margin-top:14px"><div class="panel-header"><h2>全局审计日志</h2><span class="small muted">${audit.length} 条</span></div><div class="panel-body flush"><div class="table-wrap" style="border:0;border-radius:0"><table class="data-table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>实体</th><th>摘要</th></tr></thead><tbody>${audit.length ? audit.map((item) => `<tr><td>${fmtDate(item.created_at || item.timestamp)}</td><td>${esc(item.actor_username || item.actor_name || item.actor || item.username || '—')}</td><td>${esc(item.action || '—')}</td><td>${esc(item.entity_type || item.entity_id || '—')}</td><td>${esc(item.summary || item.detail || item.metadata || '—')}</td></tr>`).join('') : '<tr><td colspan="5"><div class="empty-state">暂无审计记录</div></td></tr>'}</tbody></table></div></div></div>` : '';
    const reportButtons = [
      actionButton('download', '资产登记表 CSV', { url: '/api/reports/assets.csv', filename: 'assets.csv' }, 'button-secondary'),
      actionButton('download', '成本与折旧 CSV', { url: '/api/reports/costs.csv', filename: 'asset-costs.csv' }, 'button-secondary'),
      actionButton('download', '生命周期 CSV', { url: '/api/reports/transactions.csv', filename: 'lifecycle-transactions.csv' }, 'button-secondary'),
      actionButton('download', '工单 CSV', { url: '/api/reports/work-orders.csv', filename: 'work-orders.csv' }, 'button-secondary')
    ];
    if (can('audit.read')) reportButtons.push(actionButton('download', '审计日志 CSV', { url: '/api/reports/audit.csv', filename: 'audit-logs.csv' }, 'button-secondary'));
    setPageBody(`<section class="metric-grid"><div class="metric metric-teal"><div><div class="metric-label">资产总数</div><div class="metric-value">${esc(total)}</div></div></div><div class="metric metric-violet"><div><div class="metric-label">账面价值</div><div class="metric-value" style="font-size:20px">${esc(fmtMoney(book))}</div></div></div><div class="metric metric-amber"><div><div class="metric-label">保修到期提醒</div><div class="metric-value">${esc(warranty)}</div></div></div><div class="metric metric-blue"><div><div class="metric-label">开放工单</div><div class="metric-value">${esc(work)}</div></div></div></section><div class="layout-two"><div class="panel"><div class="panel-header"><h2>报表下载</h2></div><div class="panel-body"><div class="button-row">${reportButtons.join('')}</div><p class="form-help">下载操作会携带当前登录会话，服务端按角色返回允许的数据范围。</p></div></div><div class="panel"><div class="panel-header"><h2>财务摘要</h2></div><div class="panel-body">${renderSummaryList(summary)}</div></div></div>${auditPanel}`);
  }

  function renderSummaryList(summary) {
    const rows = collection(summary, ['costs', 'book_values', 'lifecycle', 'by_department', 'by_lifecycle']);
    if (!rows.length) return '<div class="empty-state compact">暂无财务摘要</div>';
    return `<ul class="list">${rows.slice(0, 8).map((item) => `<li class="list-item"><div class="list-main"><div class="list-title">${esc(item.label || item.category || item.status || '摘要')}</div><div class="list-meta">${esc(item.count == null ? '' : `${item.count} 项`)}</div></div><strong>${esc(fmtMoney(item.amount ?? item.value ?? item.purchase_cost))}</strong></li>`).join('')}</ul>`;
  }

  async function loadUsers() {
    pageShell('users', 'Users', '用户', '维护角色、部门和账户状态。', can('users.write') ? actionButton('user-form', '新增用户', {}, 'button-primary') : '');
    try { state.users = collection(await request('/api/users'), ['users']); renderUsers(); }
    catch (error) { setPageBody(pageError(error.message)); }
  }

  function renderUsers() {
    const rows = state.users;
    setPageBody(`<div class="panel"><div class="panel-header"><h2>用户与角色</h2><span class="small muted">${rows.length} 个账户</span></div><div class="panel-body flush"><div class="table-wrap" style="border:0;border-radius:0"><table class="data-table"><thead><tr><th>用户</th><th>角色</th><th>部门</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>${rows.length ? rows.map((user) => `<tr><td><div class="asset-primary">${esc(user.display_name || user.name || user.username)}</div><div class="asset-secondary">${esc(user.username || user.email || user.id)}</div></td><td>${badge(ROLE_LABELS[user.role] || user.role || '—', user.role === 'admin' ? 'approved' : 'info')}</td><td>${esc(user.department || '—')}</td><td>${user.active === false || user.is_active === false ? badge('已停用', 'disabled') : badge('启用', 'active')}</td><td>${fmtDate(user.last_login_at || user.last_login)}</td><td>${can('users.write') ? `${actionButton('user-form', '编辑', { id: user.id || user.user_id || user.username }, 'button-quiet')}${actionButton('user-toggle', user.active === false || user.is_active === false ? '启用' : '停用', { id: user.id || user.user_id || user.username, active: user.active === false || user.is_active === false }, 'button-secondary')}` : '<span class="small subtle">只读</span>'}</td></tr>`).join('') : '<tr><td colspan="6"><div class="empty-state">暂无用户</div></td></tr>'}</tbody></table></div></div></div>`);
  }

  function openUserForm(id) {
    if (!can('users.write')) return;
    const user = id ? state.users.find((item) => String(item.id || item.user_id || item.username) === String(id)) : null;
    const roles = optionList(Object.entries(ROLE_LABELS), user?.role || 'employee');
    openModal(user ? `编辑 ${user.display_name || user.username}` : '新增用户', `<div class="form-grid">${formField('用户名', 'user-username', user?.username, 'text', null, false, user ? '用户名通常不可修改。' : '')}${formField('显示名称', 'user-display-name', user?.display_name || user?.name, 'text', null, false)}${formField('邮箱', 'user-email', user?.email, 'email', null, false)}${formField('角色', 'user-role', user?.role || 'employee', 'select', roles, false)}${formField('部门', 'user-department', user?.department, 'text', null, false)}${formField(user ? '重置密码（可选）' : '初始密码', 'user-password', '', 'password', null, false)}${formField('备注', 'user-notes', user?.notes, 'textarea', null, true)}</div><label class="check-row" style="margin-top:13px"><input id="user-active" type="checkbox" ${user?.active === false || user?.is_active === false ? '' : 'checked'}>账户启用</label><div class="button-row" style="justify-content:flex-end;margin-top:18px">${actionButton('close-modal', '取消', {}, 'button-quiet')}<button type="button" class="button button-primary" data-action="save-user" data-id="${attr(user?.id || user?.user_id || user?.username || '')}">${user ? '保存' : '创建用户'}</button></div>`, 'Users · 账户');
  }

  async function saveUser(id) {
    const body = { username: document.getElementById('user-username').value.trim(), display_name: document.getElementById('user-display-name').value.trim(), email: document.getElementById('user-email').value.trim() || null, role: document.getElementById('user-role').value, department: document.getElementById('user-department').value.trim() || null, active: document.getElementById('user-active').checked, notes: document.getElementById('user-notes').value.trim() || null };
    const password = document.getElementById('user-password').value; if (password) body.password = password;
    try { await request(id ? `/api/users/${encodeURIComponent(id)}` : '/api/users', { method: id ? 'PATCH' : 'POST', body }); closeModal(); showToast(id ? '用户已更新' : '用户已创建'); await loadUsers(); }
    catch (error) { showToast(error.message, true); }
  }

  async function toggleUser(id, active) {
    try { await request(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { active: !active } }); showToast(active ? '用户已启用' : '用户已停用'); await loadUsers(); }
    catch (error) { showToast(error.message, true); }
  }

  async function loadIntegrations() {
    pageShell('integrations', 'Integrations', '集成', '配置适配器和同步证据；凭据只引用 secret_ref，不在界面或仓库保存明文。', can('integrations.write') ? actionButton('integration-form', '新增集成', {}, 'button-primary') : '');
    try { state.integrations = collection(await request('/api/integrations'), ['integrations']); renderIntegrations(); }
    catch (error) { setPageBody(pageError(error.message)); }
  }

  function renderIntegrations() {
    const rows = state.integrations;
    setPageBody(`<div class="panel"><div class="panel-header"><h2>连接器配置</h2><span class="small muted">${rows.length} 个</span></div><div class="panel-body flush"><div class="table-wrap" style="border:0;border-radius:0"><table class="data-table"><thead><tr><th>名称</th><th>适配器</th><th>端点</th><th>状态</th><th>最近同步</th><th>操作</th></tr></thead><tbody>${rows.length ? rows.map((item) => `<tr><td><div class="asset-primary">${esc(item.name || item.label || item.id)}</div><div class="asset-secondary">${esc(item.secret_ref ? `secret_ref: ${item.secret_ref}` : '未配置 secret_ref')}</div></td><td>${esc(item.provider || item.type || 'manual')}</td><td>${esc(item.endpoint || item.base_url || '—')}</td><td>${item.enabled === false ? badge('停用', 'disabled') : badge(item.status || '已配置', item.status === 'error' ? 'danger' : 'active')}</td><td>${fmtDate(item.last_sync_at || item.synced_at)}</td><td>${can('integrations.write') ? `${actionButton('integration-form', '编辑', { id: item.id }, 'button-quiet')}${actionButton('integration-sync', '同步', { id: item.id }, 'button-secondary')}` : '<span class="small subtle">只读</span>'}</td></tr>`).join('') : '<tr><td colspan="6"><div class="empty-state">暂无集成配置</div></td></tr>'}</tbody></table></div></div></div>`);
  }

  function openIntegrationForm(id) {
    if (!can('integrations.write')) return;
    const item = id ? state.integrations.find((entry) => String(entry.id) === String(id)) : null;
    openModal(item ? `编辑 ${item.name}` : '新增集成', `<div class="form-grid">${formField('名称', 'integration-name', item?.name, 'text', null, false)}${formField('适配器', 'integration-provider', item?.provider || item?.type || 'webhook', 'select', optionList([['ad', 'AD'], ['mdm', 'MDM'], ['snmp', 'SNMP'], ['aws', 'AWS'], ['azure', 'Azure'], ['gcp', 'GCP'], ['webhook', 'Generic Webhook'], ['manual', 'Manual']], item?.provider || item?.type || 'webhook'), false)}${formField('端点', 'integration-endpoint', item?.endpoint || item?.base_url, 'url', null, true)}${formField('secret_ref', 'integration-secret-ref', item?.secret_ref, 'text', null, false, '只填写外部密钥引用，不填写密钥正文。')}${formField('配置 JSON', 'integration-config', typeof item?.config === 'string' ? item.config : item?.config ? JSON.stringify(item.config, null, 2) : '{}', 'textarea', null, true)}${formField('说明', 'integration-notes', item?.notes, 'textarea', null, true)}</div><label class="check-row" style="margin-top:13px"><input id="integration-enabled" type="checkbox" ${item?.enabled === false ? '' : 'checked'}>启用配置</label><div class="button-row" style="justify-content:flex-end;margin-top:18px">${actionButton('close-modal', '取消', {}, 'button-quiet')}<button type="button" class="button button-primary" data-action="save-integration" data-id="${attr(item?.id || '')}">${item ? '保存' : '创建'}</button></div>`, 'Integrations · 配置');
  }

  async function saveIntegration(id) {
    let config = {};
    try { config = JSON.parse(document.getElementById('integration-config').value || '{}'); } catch (_) { showToast('配置 JSON 格式不正确', true); return; }
    const body = { name: document.getElementById('integration-name').value.trim(), type: document.getElementById('integration-provider').value, endpoint: document.getElementById('integration-endpoint').value.trim() || null, secret_ref: document.getElementById('integration-secret-ref').value.trim() || null, config, notes: document.getElementById('integration-notes').value.trim() || null, enabled: document.getElementById('integration-enabled').checked };
    try { await request(id ? `/api/integrations/${encodeURIComponent(id)}` : '/api/integrations', { method: id ? 'PATCH' : 'POST', body }); closeModal(); showToast(id ? '集成已更新' : '集成已创建'); await loadIntegrations(); }
    catch (error) { showToast(error.message, true); }
  }

  async function syncIntegration(id) {
    try { await request(`/api/integrations/${encodeURIComponent(id)}/sync`, { method: 'POST' }); showToast('同步请求已提交'); await loadIntegrations(); }
    catch (error) { showToast(error.message, true); }
  }

  async function loadAttachments(entityType, entityId, targetId) {
    const target = document.getElementById(targetId); if (!target) return;
    const data = await optional(`/api/attachments?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`, []);
    const rows = collection(data, ['attachments']);
    target.innerHTML = rows.length ? `<div class="attachment-list">${rows.map((file) => `<div class="attachment-row"><span class="attachment-name">${esc(file.original_name || file.filename || file.name || file.id)}</span><span class="action-group">${actionButton('download', '下载', { url: `/api/attachments/${encodeURIComponent(file.id)}/download`, filename: file.original_name || file.filename || 'attachment' }, 'button-quiet')}${(entityType === 'asset' && can('assets.write')) || (entityType === 'work_order' && can('workorders.write')) ? iconButton('attachment-delete', '×', { id: file.id, entityType, entityId }, 'danger', '删除') : ''}</span></div>`).join('')}</div>` : '<div class="empty-state compact">暂无附件</div>';
  }

  async function uploadAttachment(form) {
    const file = form.querySelector('input[type="file"]').files[0]; if (!file) return;
    const body = new FormData(); body.append('file', file); body.append('entity_type', form.dataset.entityType); body.append('entity_id', form.dataset.entityId);
    const type = form.dataset.entityType; const id = form.dataset.entityId;
    try { await request('/api/attachments', { method: 'POST', body }); showToast('附件已上传'); await loadAttachments(type, id, type === 'asset' ? 'asset-attachments' : 'work-order-attachments'); form.reset(); }
    catch (error) { showToast(error.message, true); }
  }

  async function deleteAttachment(id, entityType, entityId) {
    try { await request(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast('附件已删除'); await loadAttachments(entityType, entityId, entityType === 'asset' ? 'asset-attachments' : 'work-order-attachments'); }
    catch (error) { showToast(error.message, true); }
  }

  async function download(url, filename) {
    try {
      const response = await fetch(url, { cache: 'no-store', headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new ApiError(data.error || `下载失败（${response.status}）`, response.status, data);
      }
      const blob = await response.blob();
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename || 'download'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); showToast(`已下载 ${filename || '文件'}`);
    } catch (error) { showToast(error.message, true); }
  }

  function relationForm(assetId) {
    const options = state.assets.filter((asset) => asset.id !== assetId).map((asset) => [asset.id, asset.hostname || asset.id]);
    openModal('添加资产关联', `<div class="form-grid">${formField('关联资产', 'relation-asset', '', 'select', optionList(options, '', '选择资产'), true)}${formField('关系类型', 'relation-type', 'related', 'select', optionList([['related', '相关'], ['parent', '上级设备'], ['child', '下级设备'], ['depends_on', '依赖']], 'related'), true)}</div><div class="button-row" style="justify-content:flex-end;margin-top:18px">${actionButton('close-modal', '取消', {}, 'button-quiet')}<button type="button" class="button button-primary" data-action="save-relation" data-id="${attr(assetId)}">添加</button></div>`, 'Assets · 关联');
  }

  async function saveRelation(assetId) {
    try { await request(`/api/assets/${encodeURIComponent(assetId)}/relations`, { method: 'POST', body: { related_asset_id: document.getElementById('relation-asset').value, relation_type: document.getElementById('relation-type').value } }); closeModal(); showToast('资产关联已添加'); await showAssetDetail(assetId); }
    catch (error) { showToast(error.message, true); }
  }

  async function deleteRelation(assetId, relationId) {
    try { await request(`/api/assets/${encodeURIComponent(assetId)}/relations/${encodeURIComponent(relationId)}`, { method: 'DELETE' }); showToast('资产关联已删除'); await showAssetDetail(assetId); }
    catch (error) { showToast(error.message, true); }
  }

  function handleClick(target) {
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (action === 'navigate') navigate(target.dataset.page);
    else if (action === 'logout') logout(true);
    else if (action === 'close-modal') closeModal();
    else if (action === 'reload-page') navigate(state.page, false);
    else if (action === 'asset-form') openAssetForm(id);
    else if (action === 'asset-detail') showAssetDetail(id);
    else if (action === 'asset-delete') deleteAsset(id);
    else if (action === 'asset-ping') pingAsset(id);
    else if (action === 'asset-vnc') launchVnc(target.dataset.ip, target.dataset.port);
    else if (action === 'asset-qr') showQr(id);
    else if (action === 'bulk-import') openBulkImport();
    else if (action === 'submit-bulk') submitBulk();
    else if (action === 'save-asset') saveAsset(id);
    else if (action === 'transaction-form') openTransactionForm(target.dataset.assetId);
    else if (action === 'save-transaction') saveTransaction();
    else if (action === 'transaction-decision') decideTransaction(id, target.dataset.decision);
    else if (action === 'inventory-form') openInventoryForm();
    else if (action === 'save-inventory') saveInventory();
    else if (action === 'inventory-detail') inventoryDetail(id);
    else if (action === 'inventory-finalize') finalizeInventory(id);
    else if (action === 'copy-scan-link') copyScanLink(id, target.dataset.token);
    else if (action === 'difference-form') resolveDifferenceForm(target.dataset.sessionId, target.dataset.assetId, target.dataset.differenceType);
    else if (action === 'save-difference') resolveDifference(target.dataset.sessionId, target.dataset.assetId);
    else if (action === 'work-order-form') openWorkOrderForm();
    else if (action === 'save-work-order') saveWorkOrder();
    else if (action === 'work-order-detail') workOrderDetail(id);
    else if (action === 'save-work-status') saveWorkStatus(id);
    else if (action === 'add-work-comment') addWorkComment(id);
    else if (action === 'read-notification') readNotification(id);
    else if (action === 'read-all') readAllNotifications();
    else if (action === 'user-form') openUserForm(id);
    else if (action === 'save-user') saveUser(id);
    else if (action === 'user-toggle') toggleUser(id, target.dataset.active === 'true');
    else if (action === 'integration-form') openIntegrationForm(id);
    else if (action === 'save-integration') saveIntegration(id);
    else if (action === 'integration-sync') syncIntegration(id);
    else if (action === 'attachment-delete') deleteAttachment(id, target.dataset.entityType, target.dataset.entityId);
    else if (action === 'relation-form') relationForm(id);
    else if (action === 'save-relation') saveRelation(id);
    else if (action === 'relation-delete') deleteRelation(target.dataset.assetId, target.dataset.relationId);
    else if (action === 'open-url') window.open(target.dataset.url, '_blank', 'noopener');
    else if (action === 'download') download(target.dataset.url, target.dataset.filename);
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (target) { event.preventDefault(); handleClick(target); }
    if (event.target === document.getElementById('modal')) closeModal();
  });
  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-form]');
    if (form) { event.preventDefault(); if (form.dataset.form === 'attachment') uploadAttachment(form); }
  });
  document.addEventListener('input', (event) => {
    if (event.target.matches('[data-action="asset-search"]')) { state.assetFilters.query = event.target.value; renderAssets(); }
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-action="asset-filter"]')) { state.assetFilters[event.target.dataset.filter] = event.target.value; renderAssets(); }
    if (event.target.id === 'bulk-file' && event.target.files[0]) previewBulk(event.target.files[0]);
  });
  document.getElementById('login-form').addEventListener('submit', doLogin);
  window.addEventListener('popstate', () => navigate(location.hash.slice(1) || 'dashboard', false));
  window.setInterval(() => { if (state.token && state.page === 'assets') loadAssets(); }, 30000);

  const initialPage = decodeURIComponent(location.hash.slice(1) || 'dashboard');
  if (state.token) { state.page = initialPage; bootstrap(); }
}());
