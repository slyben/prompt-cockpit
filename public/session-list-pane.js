// Server-wide session list: the header's sessionCountBtn shows how many
// cockpit sessions are live across the whole process (every cwd, every
// provider - GET /api/sessions is intentionally not scoped to this tab's own
// session, see session-registry.js's toSummary), and clicking it drops
// #sessionListPane in as a fixed right-docked overlay to show name/model/
// effort per row - works the same on the pre-session launcher screen as
// mid-session (see its markup comment in index.html for why it isn't a
// normal in-flow sibling of #detailPane). The badge itself is kept fresh by
// a 10s poll (below) so it reflects sessions opened/closed in *other* tabs
// too, not just this one's own lifecycle events; the expanded list body is
// still a read-only, one-time snapshot fetched only when the panel opens -
// not worth a websocket fan-in just to keep an open list live too.
export function initSessionListPane({ panel, body, closeBtn, countBtn, headerEl }) {
  let open = false;

  function label(count) {
    return `${count} session${count === 1 ? '' : 's'}`;
  }

  async function refreshCount() {
    let sessions = [];
    try {
      const res = await fetch('/api/sessions');
      sessions = await res.json();
    } catch {
      // Best-effort - a failed fetch just leaves the last-known count
      // showing rather than replacing it with an alarming placeholder.
      return sessions;
    }
    countBtn.textContent = label(sessions.length);
    return sessions;
  }

  function renderList(sessions) {
    body.textContent = '';
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'detail-pane-placeholder';
      empty.textContent = 'No sessions running.';
      body.append(empty);
      return;
    }
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'session-list-row';
      const name = document.createElement('span');
      name.className = 'session-list-name';
      name.textContent = s.name || `(unnamed - ${s.cwd || s.id.slice(0, 8)})`;
      const meta = document.createElement('span');
      meta.className = 'session-list-meta';
      meta.textContent = [s.model, s.effort].filter(Boolean).join(' / ') || '(default model)';
      row.append(name, meta);
      body.append(row);
    }
  }

  async function openPane() {
    open = true;
    countBtn.classList.add('on');
    // Measured live, not a fixed CSS constant - the header's height isn't
    // fixed (the rate-limit banner can wrap it onto two lines).
    panel.style.top = `${headerEl.getBoundingClientRect().bottom}px`;
    panel.classList.add('enabled');
    body.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'detail-pane-placeholder';
    loading.textContent = 'Loading…';
    body.append(loading);
    const sessions = await refreshCount();
    if (!open) return; // closed again before the fetch resolved
    renderList(sessions);
  }

  function closePane() {
    if (!open) return;
    open = false;
    countBtn.classList.remove('on');
    panel.classList.remove('enabled');
  }

  countBtn.addEventListener('click', () => (open ? closePane() : openPane()));
  closeBtn.addEventListener('click', closePane);
  window.addEventListener('resize', () => {
    if (open) panel.style.top = `${headerEl.getBoundingClientRect().bottom}px`;
  });

  refreshCount();

  // Poll instead of a live push channel - other tabs' session opens/closes
  // don't reach this tab any other way (its own lifecycle events call
  // refreshCount() directly elsewhere in app.js, but that only covers this
  // tab's own session). 10s keeps the badge close enough to live without
  // adding a connection-less websocket channel just for a number that's
  // rarely stared at - see the module comment for the one-time-snapshot
  // reasoning this is layered on top of.
  setInterval(refreshCount, 10_000);

  return { refreshCount, closePane, isOpen: () => open };
}
