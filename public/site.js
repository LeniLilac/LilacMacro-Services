async function loadStatus() {
  const target = document.querySelector('#game-status');
  const container = target?.closest('[data-state]');
  if (!target) return;
  try {
    const response = await fetch('/v1/control', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('unavailable');
    const snapshot = await response.json();
    const available = snapshot.payload.game.available;
    target.textContent = available
      ? 'Game available · signed status current'
      : snapshot.payload.game.message || 'Game maintenance in progress';
    if (container) container.dataset.state = available ? 'available' : 'unavailable';
  } catch {
    target.textContent = 'Status temporarily unavailable · macro uses signed last-known-good data';
    if (container) container.dataset.state = 'unknown';
  }
}

void loadStatus();
