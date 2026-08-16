// "Browse" button for the launcher's cwd field. Browsers don't expose real
// filesystem paths from <input type=file>, so this drives GET /api/browse
// (server-side directory listing) instead - see the comment on
// listDirectory() in src/session-launcher.js.

export function initDirBrowser({ modal, pathLabel, list, upButton, selectButton, cancelButton, onSelect }) {
  let currentPath = null;
  // Per-open override: settings.js's "+ Add folder" reuses this same modal
  // instance instead of standing up a second one, so open() can hand it a
  // one-off callback. Falls back to the constructor's onSelect (the cwd
  // launcher's use) when no override is given.
  let activeOnSelect = onSelect;

  async function load(path) {
    const res = await fetch(`/api/browse?path=${encodeURIComponent(path || '')}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`could not browse: ${err.error || res.statusText}`);
      return;
    }
    const data = await res.json();
    currentPath = data.path;
    pathLabel.textContent = data.path;
    upButton.disabled = !data.parent;
    upButton.dataset.parent = data.parent || '';

    list.innerHTML = '';
    for (const entry of data.entries) {
      const li = document.createElement('li');
      li.textContent = entry.name;
      li.addEventListener('click', () => load(entry.path));
      list.append(li);
    }
  }

  upButton.addEventListener('click', () => {
    if (upButton.dataset.parent) load(upButton.dataset.parent);
  });
  selectButton.addEventListener('click', () => {
    if (currentPath) activeOnSelect(currentPath);
    close();
  });
  cancelButton.addEventListener('click', close);

  function open(startPath, onSelectOverride) {
    activeOnSelect = onSelectOverride || onSelect;
    modal.style.display = 'flex';
    load(startPath || '');
  }
  function close() {
    modal.style.display = 'none';
  }

  return { open, close };
}
