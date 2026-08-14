async function loadStatus() {
  const target = document.querySelector('#game-status');
  if (!target) return;
  try {
    const response = await fetch('/v1/control', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('unavailable');
    const snapshot = await response.json();
    target.textContent = snapshot.payload.game.available
      ? 'Game available · signed status current'
      : snapshot.payload.game.message || 'Game maintenance in progress';
  } catch {
    target.textContent = 'Status temporarily unavailable · macro uses signed last-known-good data';
  }
}
void loadStatus();
