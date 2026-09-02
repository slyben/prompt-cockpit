// GET /api/sessions is server-wide, not scoped to this tab. The count badge
// polls every 10s to reflect other tabs' opens/closes; the expanded list is
// a one-time snapshot fetched on open. Cross-tab "switch to this session"
// uses BroadcastChannel, since window.focus() can't bring a background tab
// forward without its own user activation - onFocusRequested just flags it.
import { initResizablePanel } from '/resizable-panel.js';

const FOCUS_CHANNEL_NAME = 'cockpit:session-focus';

export function initSessionListPane({ panel, body, closeBtn, countBtn, headerEl, handshakeRow, handshakeValue, handshakeCopyBtn, handshakeRegenBtn, getSelfId, onFocusRequested, resizeHandle, initialWidth, onWidthChange }) {
  let open = false;

  let focusChannel = null;
  try {
    focusChannel = new BroadcastChannel(FOCUS_CHANNEL_NAME);
  } catch {
    // BroadcastChannel unsupported (old Safari) - row clicks below just
    // won't flag the other tab; everything else in this pane still works.
  }
  if (focusChannel) {
    focusChannel.addEventListener('message', (event) => {
      const targetId = event.data && event.data.id;
      if (targetId && getSelfId && targetId === getSelfId()) onFocusRequested?.();
    });
  }

  function label(count) {
    return `${count} session${count === 1 ? '' : 's'}`;
  }

  // This panel is a `position: fixed` overlay, not an in-flow flex sibling
  // like detail-pane.js, so there's no --detail-pane-offset var to sync -
  // just the inline width itself.
  initResizablePanel({
    panel,
    handle: resizeHandle,
    minWidthPx: 280,
    initialWidth,
    onWidthChange,
    isNarrowLayout: () => window.matchMedia('(max-width: 900px)').matches,
  });

  // Per-process delegation secret, shown copyable so it can be pasted into
  // a sibling session to mark it trusted for delegation. Fetched fresh each
  // time the pane opens, same one-time-snapshot reasoning as the list.
  async function refreshHandshake() {
    if (!handshakeRow) return;
    try {
      const res = await fetch('/api/handshake');
      const { secret } = await res.json();
      handshakeValue.textContent = secret;
      handshakeValue.dataset.secret = secret;
    } catch {
      handshakeValue.textContent = '(unavailable)';
    }
  }

  if (handshakeCopyBtn) {
    handshakeCopyBtn.addEventListener('click', async () => {
      const secret = handshakeValue.dataset.secret;
      if (!secret) return;
      try {
        await navigator.clipboard.writeText(secret);
        handshakeCopyBtn.textContent = 'Copied';
        setTimeout(() => { handshakeCopyBtn.textContent = 'Copy'; }, 1200);
      } catch {
        // Clipboard permission denied or unavailable - the value is still
        // selectable/visible in handshakeValue, so this is a soft failure.
      }
    });
  }

  if (handshakeRegenBtn) {
    handshakeRegenBtn.addEventListener('click', async () => {
      // Rotating cuts off every currently-trusted session (see
      // regenerateHandshakeSecret's own comment) - confirm since this is
      // the "something looked wrong" hammer, not a routine action.
      if (!confirm('Regenerate the handshake secret? Every session not re-synced afterward loses delegation trust.')) return;
      const res = await fetch('/api/handshake/regenerate', { method: 'POST' });
      const { secret } = await res.json();
      handshakeValue.textContent = secret;
      handshakeValue.dataset.secret = secret;
      if (open) refreshCount().then(renderList); // trust badges below are now stale otherwise
    });
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
      const isSelf = getSelfId && s.id === getSelfId();
      if (isSelf) {
        row.classList.add('self');
        row.title = 'This is the current tab.';
      } else if (focusChannel) {
        row.classList.add('clickable');
        row.title = 'Flag the tab with this session (❗ in its title) so you can find it - browsers won\'t let this page switch tabs for you.';
        row.addEventListener('click', () => {
          focusChannel.postMessage({ id: s.id });
          closePane();
        });
      }
      const name = document.createElement('span');
      name.className = 'session-list-name';
      name.textContent = s.name || `(unnamed - ${s.cwd || s.id.slice(0, 8)})`;
      const meta = document.createElement('span');
      meta.className = 'session-list-meta';
      meta.textContent = [s.model, s.effort].filter(Boolean).join(' / ') || '(default model)';
      row.append(name, meta);
      // Read-only here - this pane spans every tab/session server-wide, but
      // only the OWNING tab holds that session's own bearer token, so
      // fixing an untrusted row (pasting a value) has to happen from
      // Settings on that session's own tab, not from here. See
      // registry.isSessionTrusted's comment.
      if (s.handshakeTrusted === false) {
        const untrusted = document.createElement('span');
        untrusted.className = 'session-list-meta';
        untrusted.title = 'This session\'s delegation handshake does not match the server - it can\'t send or receive delegated tasks until re-synced from its own Settings panel.';
        untrusted.textContent = '⚠ handshake mismatch';
        row.append(untrusted);
      }
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
    refreshHandshake();
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

  // Poll instead of a push channel - other tabs' session opens/closes don't
  // reach this tab any other way (app.js's own lifecycle events only cover
  // this tab's session).
  setInterval(refreshCount, 10_000);

  return { refreshCount, closePane, isOpen: () => open };
}
