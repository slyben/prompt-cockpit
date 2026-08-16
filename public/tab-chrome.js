// Browser tab title + favicon (plan MVP3): reflects session activity so an
// unfocused tab is scannable from the tab strip instead of needing a
// terminal-bell substitute, plus a user-settable tab name that stops
// getting overwritten once set (`userNamed`).
const DOT = {
  idle: '#8a8f98',
  running: '#5b8cff',
  attention: '#ff6b6b',
};

const STATE_TO_DOT = {
  running: 'running',
  starting: 'running',
  error: 'attention',
};

// An 8-point starburst/asterisk glyph - closer to Claude's own radial mark
// (an abstract approximation, not a traced copy of it) than a plain dot,
// same state-color coding as before (DOT above). Alternating outer/inner
// radius vertices around the center, generated once by hand (not computed
// at runtime - it's a fixed shape, no reason to redo the trig on every
// render).
function faviconDataUrl(color) {
  const path = 'M8,0.7 L8.99,5.6 L13.16,2.84 L10.4,7.01 L15.3,8 L10.4,8.99 L13.16,13.16 L8.99,10.4 L8,15.3 L7.01,10.4 L2.84,13.16 L5.6,8.99 L0.7,8 L5.6,7.01 L2.84,2.84 L7.01,5.6 Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="${path}" fill="${color}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const FAVICONS = Object.fromEntries(Object.entries(DOT).map(([key, color]) => [key, faviconDataUrl(color)]));

export function initTabChrome({ faviconEl = document.getElementById('favicon'), defaultName = 'Prompt Cockpit' } = {}) {
  let autoName = defaultName;
  let userName = null; // set once the user renames the tab; auto-naming stops touching it from then on
  let dotState = 'idle';
  let needsAttention = false;

  function render() {
    const name = userName || autoName;
    const prefix = needsAttention ? '❗ ' : ''; // exclamation - the loudest signal, wins over the running dot
    document.title = `${prefix}${name}`;
    faviconEl.href = FAVICONS[needsAttention ? 'attention' : dotState] || FAVICONS.idle;
  }

  // Called whenever the session itself has an obvious name (cwd, mostly) -
  // a no-op once the user has renamed the tab, so an unrelated cwd/state
  // change can't stomp on a name they chose deliberately.
  function setAutoName(name) {
    autoName = name || defaultName;
    render();
  }

  function rename(name) {
    userName = name && name.trim() ? name.trim() : null;
    render();
  }

  function setState(sessionState) {
    dotState = STATE_TO_DOT[sessionState] || 'idle';
    render();
  }

  function setNeedsAttention(value) {
    needsAttention = value;
    render();
  }

  window.addEventListener('focus', () => setNeedsAttention(false));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setNeedsAttention(false);
  });

  render();

  return { setAutoName, rename, setState, setNeedsAttention, isUserNamed: () => userName !== null };
}
