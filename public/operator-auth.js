// Browser half of the process-level operator token. Captures `?op=` from
// the console URL (server.js prints it on listen), stores it in
// localStorage, and attaches `X-Cockpit-Operator` to every /api/ fetch.
// Navigation downloads (export .md) and the websocket still need `op=`
// in the query string - browsers cannot set that header on those.
const STORAGE_KEY = 'cockpit:operatorToken';

function captureFromUrl() {
  try {
    const u = new URL(location.href);
    const fromUrl = u.searchParams.get('op');
    if (!fromUrl) return;
    localStorage.setItem(STORAGE_KEY, fromUrl);
    u.searchParams.delete('op');
    history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`);
  } catch {
    // file: or odd location - leave storage alone
  }
}

captureFromUrl();

export function getOperatorToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

// Not exported - only initOperatorGate's submit handler (below, in this
// file) calls it; every other module goes through appendOperatorQuery/the
// patched fetch instead of setting the token directly.
function setOperatorToken(value) {
  const trimmed = (value || '').trim();
  try {
    if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode
  }
}

export function appendOperatorQuery(searchParams) {
  const token = getOperatorToken();
  if (token) searchParams.set('op', token);
  return searchParams;
}

const origFetch = window.fetch.bind(window);
window.fetch = function patchFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input && input.url;
  if (url && url.includes('/api/')) {
    const headers = new Headers(init.headers || {});
    const token = getOperatorToken();
    if (token && !headers.has('X-Cockpit-Operator')) headers.set('X-Cockpit-Operator', token);
    init = { ...init, headers };
  }
  return origFetch(input, init);
};

export function initOperatorGate({ banner, input, saveBtn, onSaved } = {}) {
  if (!banner || !input || !saveBtn) return { show() {}, hide() {} };

  function show() {
    banner.hidden = false;
    input.value = getOperatorToken();
    input.focus();
  }
  function hide() {
    banner.hidden = true;
  }

  banner.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    setOperatorToken(value);
    hide();
    onSaved?.();
  });

  if (!getOperatorToken()) show();
  return { show, hide };
}
