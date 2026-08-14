const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
let state;
let commandPending = false;
const featureIds = [
  'mode.story',
  'mode.raid',
  'mode.challenge',
  'mode.expedition',
  'mode.event',
  'task.calendar-claim',
  'task.gold-shop',
  'task.raid-shop',
  'task.expedition-shop',
  'task.code-redeem',
  'task.gold-mine-refuel',
  'task.resource-drill-refuel',
  'feature.route-optimizer',
  'feature.team-swap',
  'feature.settings-normalizer',
];

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
  });
  if (!response.ok)
    throw new Error((await response.json().catch(() => ({}))).error || 'Request failed.');
  return response.status === 204 ? null : response.json();
}

function envelope(command) {
  return { commandId: crypto.randomUUID(), expectedRevision: state.revision, command };
}

function notice(message, error = false) {
  const node = document.querySelector('#notice');
  node.hidden = false;
  node.textContent = message;
  node.classList.toggle('error', error);
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => (node.hidden = true), 6000);
}

async function command(value, success = 'Signed control snapshot published.') {
  if (commandPending) return;
  commandPending = true;
  setCommandBusy(true);
  try {
    await request('/admin/api/commands', { method: 'POST', body: JSON.stringify(envelope(value)) });
    await loadState();
    await loadAudit();
    notice(success);
  } catch (error) {
    notice(error.message, true);
  } finally {
    commandPending = false;
    setCommandBusy(false);
  }
}

function setCommandBusy(busy) {
  document.querySelectorAll('form button[type="submit"]').forEach((button) => {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  });
}

async function loadState() {
  state = await request('/admin/api/state');
  document.querySelector('#revision').textContent = state.revision;
  const availability = document.querySelector('#availability-form');
  availability.available.value = String(state.game.operatorAvailable);
  availability.message.value = state.game.message || '';
  renderList(
    '#codes',
    state.codes,
    (item) => `${item.code}${item.expiresAt ? ` · expires ${formatDate(item.expiresAt)}` : ''}`,
    async (item) => {
      if (await confirmAction(`Remove redeem code “${item.code}”?`))
        await command({ type: 'code.remove', code: item.code }, `Removed code ${item.code}.`);
    },
  );
  renderList(
    '#disablements',
    state.disablements,
    (item) =>
      `${item.feature} · ${item.reason}${item.expiresAt ? ` · until ${formatDate(item.expiresAt)}` : ''}`,
    async (item) => {
      if (await confirmAction(`Re-enable ${item.feature}?`))
        await command(
          { type: 'feature.enable', feature: item.feature },
          `Re-enabled ${item.feature}.`,
        );
    },
  );
  renderList(
    '#schedules-list',
    state.schedules,
    (item) =>
      `${scheduleName(item.key)} · ${formatDate(item.nextAt)} · every ${formatCadence(item.cadenceSeconds)}`,
  );
}

function renderList(selector, items, label, action) {
  const root = document.querySelector(selector);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No active entries.';
    root.replaceChildren(empty);
    return;
  }
  root.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('div');
      row.className = 'item';
      const text = document.createElement('span');
      text.textContent = label(item);
      row.append(text);
      if (action) {
        const button = document.createElement('button');
        button.className = 'button small';
        button.textContent = 'Remove';
        button.onclick = () => void action(item);
        row.append(button);
      }
      return row;
    }),
  );
}

async function loadDiagnostics() {
  const records = await request('/admin/api/diagnostics?limit=100');
  const rows = records.map((record) => {
    const row = document.createElement('tr');
    row.append(
      cell(record.fileName),
      cell(formatBytes(record.sizeBytes)),
      statusCell(record.status),
      cell(formatDate(record.createdAt)),
      cell(formatDate(record.expiresAt)),
      diagnosticActions(record),
    );
    return row;
  });
  document.querySelector('#diagnostic-rows').replaceChildren(...rows);
  if (!rows.length) renderEmptyRow('#diagnostic-rows', 6, 'No diagnostic uploads.');
}

function diagnosticActions(record) {
  const node = document.createElement('td');
  node.className = 'row-actions';
  if (record.status === 'Pending') {
    node.append(
      actionButton('Accept', () => moderate(record, 'accept')),
      actionButton('Reject', () => moderate(record, 'reject'), true),
    );
  } else if (record.status === 'Accepted') {
    node.append(
      actionButton('Download', () => downloadDiagnostic(record)),
      actionButton('Delete', () => moderate(record, 'delete'), true),
    );
  } else if (['Uploading', 'Verifying', 'Failed', 'Expired'].includes(record.status)) {
    node.append(actionButton('Delete', () => moderate(record, 'delete'), true));
  } else {
    node.textContent = '—';
  }
  return node;
}

async function downloadDiagnostic(record) {
  try {
    const result = await request(
      `/admin/api/diagnostics/${encodeURIComponent(record.id)}/download`,
      { method: 'POST' },
    );
    location.assign(result.url);
  } catch (error) {
    notice(error.message, true);
  }
}

async function moderate(record, action) {
  const verb =
    action === 'accept' ? 'Accept' : action === 'reject' ? 'Reject and delete' : 'Delete';
  if (!(await confirmAction(`${verb} “${record.fileName}” (${formatBytes(record.sizeBytes)})?`)))
    return;
  try {
    await request(`/admin/api/diagnostics/${record.id}/moderate`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    await Promise.all([loadDiagnostics(), loadAudit()]);
    notice(`Diagnostic ${action} completed.`);
  } catch (error) {
    notice(error.message, true);
  }
}

async function loadAudit() {
  const audit = await request('/admin/api/audit?limit=100');
  const combined = [
    ...audit.control.map((record) => ({
      time: record.createdAt,
      actor: `${record.actor.kind}:${record.actor.userId}`,
      action: record.command.type,
      target: `revision ${record.resultingRevision}`,
    })),
    ...audit.diagnostics.map((record) => ({
      time: record.createdAt,
      actor: `${record.actor.kind}:${record.actor.userId}`,
      action: record.action,
      target: record.uploadId,
    })),
  ].sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
  const rows = combined.map((record) => {
    const row = document.createElement('tr');
    row.append(
      cell(formatDate(record.time)),
      cell(record.actor),
      cell(record.action),
      cell(record.target),
    );
    return row;
  });
  document.querySelector('#audit-rows').replaceChildren(...rows);
  if (!rows.length) renderEmptyRow('#audit-rows', 4, 'No administrative actions yet.');
}

function actionButton(label, action, destructive = false) {
  const button = document.createElement('button');
  button.className = `button small${destructive ? ' warning' : ''}`;
  button.textContent = label;
  button.onclick = () => void action();
  return button;
}

function cell(value) {
  const node = document.createElement('td');
  node.textContent = value;
  return node;
}

function statusCell(status) {
  const node = cell(status);
  node.className = `status status-${status.toLowerCase()}`;
  return node;
}

function renderEmptyRow(selector, columns, message) {
  const row = document.createElement('tr');
  const node = cell(message);
  node.colSpan = columns;
  node.className = 'empty-state';
  row.append(node);
  document.querySelector(selector).replaceChildren(row);
}

function confirmAction(message) {
  const dialog = document.querySelector('#confirm-dialog');
  document.querySelector('#confirm-message').textContent = message;
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {
      once: true,
    }),
  );
}

function utc(value) {
  return value ? new Date(value).toISOString() : null;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString(undefined, { timeZoneName: 'short' }) : '—';
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function scheduleName(key) {
  return (
    {
      'gold-shop-reset': 'Gold shop reset',
      'raid-shop-reset': 'Raid shop reset',
      'expedition-shop-reset': 'Expedition shop reset',
    }[key] || key
  );
}

function formatCadence(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  return `${seconds} seconds`;
}

document.querySelector('#feature-form [name="feature"]').replaceChildren(
  ...featureIds.map((id) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    return option;
  }),
);

document.querySelector('#availability-form').onsubmit = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  void command({
    type: 'game.availability',
    available: form.get('available') === 'true',
    message: form.get('message') || null,
  });
};
document.querySelector('#code-form').onsubmit = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  void command({ type: 'code.add', code: form.get('code'), expiresAt: utc(form.get('expiresAt')) });
  event.currentTarget.reset();
};
document.querySelector('#schedule-form').onsubmit = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  void command({
    type: 'schedule.set',
    key: form.get('key'),
    nextAt: utc(form.get('nextAt')),
    cadenceSeconds: Number(form.get('cadenceSeconds')),
  });
};
document.querySelector('#feature-form').onsubmit = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  void command({
    type: 'feature.disable',
    feature: form.get('feature'),
    reason: form.get('reason'),
    expiresAt: utc(form.get('expiresAt')),
  });
};
document.querySelector('#schedule-form [name="key"]').onchange = (event) => {
  document.querySelector('#schedule-form [name="cadenceSeconds"]').value =
    event.target.value === 'gold-shop-reset'
      ? 86400
      : event.target.value.startsWith('expedition-shop')
        ? 172800
        : 604800;
};
document.querySelector('#refresh-diagnostics').onclick = () =>
  void loadDiagnostics().catch((error) => notice(error.message, true));
document.querySelector('#refresh-audit').onclick = () =>
  void loadAudit().catch((error) => notice(error.message, true));
document.querySelector('#logout').onclick = async () => {
  await request('/auth/logout', { method: 'POST' });
  location.href = '/';
};

document.querySelector('#schedule-form [name="cadenceSeconds"]').value = 86400;
void Promise.all([loadState(), loadDiagnostics(), loadAudit()]).catch((error) =>
  notice(error.message, true),
);
