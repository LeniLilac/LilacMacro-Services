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

function revealSections() {
  const targets = [...document.querySelectorAll('[data-reveal]')];
  if (targets.length === 0) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const target of targets) target.classList.add('is-visible');
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  for (const target of targets) observer.observe(target);
}

void loadStatus();
revealSections();
