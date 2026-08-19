// Settings modal opened by the header's cog button. Two things live here:
// - persisted preferences (localStorage, survives reload - same pattern as
//   app.js's ACTIVE_SESSION_KEY), currently autoCollapsePreviousGroup and
//   customFolders
//
// Settings-store boundary (see session-registry.js's own comment for the
// full picture): localStorage is for per-browser UI preferences that have
// no meaning outside this one browser profile - they don't sync across
// tabs on a different machine, don't survive "open this cwd from another
// computer", and the server never sees them. Anything that should follow a
// *project* around (regardless of which browser opens it) belongs instead
// in session-defaults.js/plugin-settings.js's shared
// `.claude/settings.local.json`, not here.
// - Close session, moved off the header's row of always-visible buttons and
//   in here instead: it permanently ends the live process (see its own
//   confirm() text), which doesn't belong one accidental click away from
//   Send.
const STORAGE_KEY = 'cockpit:settings';
// customFolders: [{ id, label, path }, ...] - the "@" picker's virtual
// folders beyond "Local folder" (file-picker.js). Used to be a single
// screenshotDir string; loadSettings() below migrates that one-time.
const DEFAULTS = {
  autoCollapsePreviousGroup: true,
  customFolders: [],
  screenshotsSeeded: false,
  turnChartEnabled: false,
  turnChartMetric: 'cost',
  turnChartExcludeCacheMisses: false,
  taskPanelEnabled: false,
  showMessageTimestamps: false,
  // Default ON, unlike the other two panels above - Decision 3 (tool-call
  // presentation redesign) calls for the detail pane docked by default when
  // a session is active, not closed-by-default/slide-in.
  detailPaneEnabled: true,
  // Debug option, off by default - see setPendingTurnsBadgeEnabled below and
  // its checkbox's own hint text in index.html for what this actually shows.
  pendingTurnsBadgeEnabled: false,
  // Drag-resized (detail-pane.js's resizeHandle) - persisted the same way
  // turnChartMetric is, via the standalone patchSettings() below rather than
  // the settings-modal machinery, since there's no checkbox/select for this,
  // just a drag handle.
  detailPaneWidth: 380,
};

function makeFolderId() {
  return `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Exported (rather than only used internally, like before) so app.js can
// read turnChartMetric/turnChartExcludeCacheMisses before turn-chart.js's
// own initTurnChart() runs - that call both builds metricSelect's <option>s
// (clobbering any value set on it beforehand) and captures
// excludeCacheMissCheckbox.checked into a closured variable at call time,
// so the persisted value has to be in place before or applied via a
// synthetic change event after, not just read afterward. See app.js's
// turnChart setup.
export function loadSettings() {
  let settings;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    settings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    settings = { ...DEFAULTS }; // corrupt/blocked storage - fall back rather than throw
  }
  // One-time migration: an old build stored a single screenshotDir string.
  // Fold it into the new customFolders list so nobody's existing setting
  // silently vanishes, then drop the old key.
  if (typeof settings.screenshotDir === 'string' && settings.screenshotDir.trim()) {
    settings.customFolders = [...settings.customFolders, { id: makeFolderId(), label: 'Screenshots', path: settings.screenshotDir.trim() }];
    settings.screenshotsSeeded = true;
  }
  if ('screenshotDir' in settings) {
    delete settings.screenshotDir;
    saveSettings(settings);
  }
  return settings;
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // private browsing / quota - setting just won't survive reload, not fatal
  }
}

// Standalone read-modify-write for a caller that only wants to persist one
// or two keys and isn't otherwise holding the `settings` object initSettings()
// closes over - turn-chart.js's metric/exclude-cache-miss picks (via app.js)
// are the first use, so they don't need their own bespoke localStorage
// wiring alongside this module's.
export function patchSettings(patch) {
  const settings = loadSettings();
  Object.assign(settings, patch);
  saveSettings(settings);
  return settings;
}

export function initSettings({
  modal,
  cogButton,
  closeButton,
  autoCollapseCheckbox,
  customFoldersListEl,
  addCustomFolderButton,
  onBrowseFolder,
  turnChartCheckbox,
  timestampsCheckbox,
  detailPaneCheckbox,
  pendingTurnsBadgeCheckbox,
  closeSessionButton,
  onAutoCollapseChange,
  onTurnChartEnabledChange,
  onTaskPanelEnabledChange,
  onTimestampsChange,
  onDetailPaneEnabledChange,
  onPendingTurnsBadgeEnabledChange,
  onCloseSession,
  onOpen,
}) {
  const settings = loadSettings();

  // Every write below used to call saveSettings(settings) directly, writing
  // this whole closured snapshot back to localStorage - including whatever
  // keys it captured at the moment initSettings() ran. If patchSettings()
  // (app.js's turn-chart metric/exclude-cache-miss picks) wrote a key after
  // that snapshot was taken, the next checkbox toggle in this modal would
  // silently revert it: this save had the *pre-patch* value for that key.
  // persist() instead reloads fresh from localStorage right before writing
  // patch merges on top of whatever's actually there, and folds the result
  // back into `settings` so this closure's own reads (renderCustomFolders,
  // getCustomFolders, etc.) stay in sync too.
  function persist(patch) {
    Object.assign(settings, patchSettings(patch));
  }

  autoCollapseCheckbox.checked = settings.autoCollapsePreviousGroup;
  turnChartCheckbox.checked = settings.turnChartEnabled;
  timestampsCheckbox.checked = settings.showMessageTimestamps;
  detailPaneCheckbox.checked = settings.detailPaneEnabled;
  pendingTurnsBadgeCheckbox.checked = settings.pendingTurnsBadgeEnabled;
  onAutoCollapseChange(settings.autoCollapsePreviousGroup);
  onTurnChartEnabledChange(settings.turnChartEnabled);
  onTaskPanelEnabledChange(settings.taskPanelEnabled);
  onTimestampsChange(settings.showMessageTimestamps);
  onDetailPaneEnabledChange(settings.detailPaneEnabled);
  onPendingTurnsBadgeEnabledChange(settings.pendingTurnsBadgeEnabled);
  renderCustomFolders();

  // "searchable in @" implies this already works out of the box, so a user
  // who's never opened Settings still needs a working default - seed the
  // list with the OS-detected Screenshots folder exactly once
  // (screenshotsSeeded latches so a user who deliberately removes it later
  // never gets it silently re-added). Fires even if customFolders already
  // has entries (e.g. from the screenshotDir migration above) - it only
  // decides whether to add, never touches what's already there.
  if (!settings.screenshotsSeeded) {
    fetch('/api/os-defaults')
      .then((r) => r.json())
      .then((data) => {
        const customFolders = data.screenshotDir
          ? [...settings.customFolders, { id: makeFolderId(), label: 'Screenshots', path: data.screenshotDir }]
          : settings.customFolders;
        persist({ screenshotsSeeded: true, customFolders });
        renderCustomFolders();
      })
      .catch(() => {}); // offline/blocked - just skip the seed, not fatal
  }

  function renderCustomFolders() {
    customFoldersListEl.innerHTML = '';
    for (const folder of settings.customFolders) {
      const li = document.createElement('li');
      li.className = 'custom-folder-row';

      const label = document.createElement('span');
      label.className = 'cmd-name';
      label.textContent = folder.label;

      const pathSpan = document.createElement('span');
      pathSpan.className = 'cmd-desc';
      pathSpan.textContent = folder.path;
      pathSpan.title = folder.path;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'custom-folder-remove';
      removeBtn.textContent = '−'; // minus sign
      removeBtn.title = `Remove ${folder.label}`;
      removeBtn.addEventListener('click', () => {
        persist({ customFolders: settings.customFolders.filter((f) => f.id !== folder.id) });
        renderCustomFolders();
      });

      li.append(label, pathSpan, removeBtn);
      customFoldersListEl.append(li);
    }
  }

  if (addCustomFolderButton) {
    addCustomFolderButton.addEventListener('click', () => {
      if (!onBrowseFolder) return;
      onBrowseFolder((chosenPath) => {
        if (!chosenPath) return;
        const defaultLabel = chosenPath.split(/[\\/]/).filter(Boolean).pop() || chosenPath;
        const label = (window.prompt('Label for this folder:', defaultLabel) || '').trim() || defaultLabel;
        persist({ customFolders: [...settings.customFolders, { id: makeFolderId(), label, path: chosenPath }] });
        renderCustomFolders();
      });
    });
  }

  cogButton.addEventListener('click', () => {
    modal.style.display = 'flex';
    if (onOpen) onOpen();
  });
  closeButton.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Tabs (General / MCP / Plugins) - each tab button's data-settings-tab
  // matches a panel's data-settings-tab-panel; switching just flips which
  // panel is visible and which button carries .active. Doesn't reset to
  // "general" on close/reopen - staying on the tab you were just looking
  // at (e.g. MCP) across opens is more useful than snapping back.
  const tabButtons = [...modal.querySelectorAll('[data-settings-tab]')];
  const tabPanels = [...modal.querySelectorAll('[data-settings-tab-panel]')];
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.settingsTab;
      for (const b of tabButtons) b.classList.toggle('active', b === btn);
      for (const p of tabPanels) p.style.display = p.dataset.settingsTabPanel === target ? 'flex' : 'none';
    });
  }

  autoCollapseCheckbox.addEventListener('change', () => {
    persist({ autoCollapsePreviousGroup: autoCollapseCheckbox.checked });
    onAutoCollapseChange(settings.autoCollapsePreviousGroup);
  });

  turnChartCheckbox.addEventListener('change', () => setTurnChartEnabled(turnChartCheckbox.checked));
  detailPaneCheckbox.addEventListener('change', () => setDetailPaneEnabled(detailPaneCheckbox.checked));
  timestampsCheckbox.addEventListener('change', () => {
    persist({ showMessageTimestamps: timestampsCheckbox.checked });
    onTimestampsChange(timestampsCheckbox.checked);
  });
  pendingTurnsBadgeCheckbox.addEventListener('change', () => {
    persist({ pendingTurnsBadgeEnabled: pendingTurnsBadgeCheckbox.checked });
    onPendingTurnsBadgeEnabledChange(pendingTurnsBadgeCheckbox.checked);
  });

  closeSessionButton.addEventListener('click', () => {
    close();
    onCloseSession();
  });

  function close() {
    modal.style.display = 'none';
  }

  // Shared by the checkbox above and app.js's turnChartToggleBtn (the "same
  // line as Agents" button) - two entry points, one persisted value, so
  // flipping either keeps the other in sync instead of drifting.
  function setTurnChartEnabled(value) {
    turnChartCheckbox.checked = value;
    persist({ turnChartEnabled: value });
    onTurnChartEnabledChange(value);
  }

  // Unlike setTurnChartEnabled/setDetailPaneEnabled above, there's no
  // settings-modal checkbox to keep in sync here - taskPanelToggleBtn (the
  // "same line as the cost graph" button, app.js) is the only entry point,
  // since the panel itself only ever appears once a session has a task.
  function setTaskPanelEnabled(value) {
    persist({ taskPanelEnabled: value });
    onTaskPanelEnabledChange(value);
  }

  // Same shape again, for the tool-call detail pane's toggle button +
  // settings-modal checkbox pair (default true, unlike the two above).
  function setDetailPaneEnabled(value) {
    detailPaneCheckbox.checked = value;
    persist({ detailPaneEnabled: value });
    onDetailPaneEnabledChange(value);
  }

  return {
    getCustomFolders: () => settings.customFolders,
    isTurnChartEnabled: () => settings.turnChartEnabled,
    setTurnChartEnabled,
    isTaskPanelEnabled: () => settings.taskPanelEnabled,
    setTaskPanelEnabled,
    isDetailPaneEnabled: () => settings.detailPaneEnabled,
    setDetailPaneEnabled,
    isPendingTurnsBadgeEnabled: () => settings.pendingTurnsBadgeEnabled,
  };
}
