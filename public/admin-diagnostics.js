const preverifyLogs = document.querySelector('#preverify-logs');

async function loadDiagnosticSettings() {
  const settings = await request('/admin/api/diagnostics/settings');
  preverifyLogs.checked = settings.preverifyLogs;
}

preverifyLogs.onchange = async () => {
  const requested = preverifyLogs.checked;
  preverifyLogs.disabled = true;
  try {
    const settings = await request('/admin/api/diagnostics/settings', {
      method: 'POST',
      body: JSON.stringify({ preverifyLogs: requested }),
    });
    preverifyLogs.checked = settings.preverifyLogs;
    notice(
      settings.preverifyLogs ? 'New logs will be pre-verified.' : 'Pre-verification disabled.',
    );
  } catch (error) {
    preverifyLogs.checked = !requested;
    notice(error.message, true);
  } finally {
    preverifyLogs.disabled = false;
  }
};

void loadDiagnosticSettings().catch((error) => notice(error.message, true));
