async function loadApiKeys() {
  const keys = await request('/admin/api/keys');
  const rows = keys.map((key) => {
    const row = document.createElement('tr');
    const action = document.createElement('td');
    const active = !key.revokedAt && Date.parse(key.expiresAt) > Date.now();
    if (active) action.append(actionButton('Revoke', () => revokeApiKey(key), true));
    else action.textContent = key.revokedAt ? 'Revoked' : 'Expired';
    row.append(
      cell(key.name),
      cell(key.prefix),
      cell(key.scopes.join(', ')),
      cell(formatDate(key.createdAt)),
      cell(formatDate(key.expiresAt)),
      cell(formatDate(key.lastUsedAt)),
      cell(String(key.useCount)),
      action,
    );
    return row;
  });
  document.querySelector('#api-key-rows').replaceChildren(...rows);
  if (!rows.length) renderEmptyRow('#api-key-rows', 8, 'No API keys created.');
}

async function revokeApiKey(key) {
  if (!(await confirmAction(`Revoke “${key.name}” (${key.prefix})?`))) return;
  try {
    await request(`/admin/api/keys/${key.id}/revoke`, { method: 'POST' });
    await loadApiKeys();
    notice('API key revoked.');
  } catch (error) {
    notice(error.message, true);
  }
}

const apiKeyForm = document.querySelector('#api-key-form');
apiKeyForm.onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const scopes = form.getAll('scopes');
  if (!scopes.length) return notice('Select at least one read scope.', true);
  try {
    const result = await request('/admin/api/keys', {
      method: 'POST',
      body: JSON.stringify({
        name: form.get('name'),
        scopes,
        expiresInDays: Number(form.get('expiresInDays')),
      }),
    });
    document.querySelector('#api-key-token').value = result.token;
    document.querySelector('#api-key-result').hidden = false;
    event.currentTarget.reset();
    await loadApiKeys();
    notice('API key created. Copy it now; only its hash is stored.');
  } catch (error) {
    notice(error.message, true);
  }
};
document.querySelector('#copy-api-key').onclick = () =>
  void copyValue('#api-key-token', 'API key copied.');
void loadApiKeys().catch((error) => notice(error.message, true));
