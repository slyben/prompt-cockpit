// Settings modal's Plugins section. Unlike mcp-panel.js, there's no live
// enable/disable call on Query - only a read-only list (reloadPlugins()) and
// a settings.local.json flag that takes effect on next session start/resume,
// not immediately. The toggle here writes that flag; it does not touch the
// running session, and the list isn't re-fetched after flipping it (the
// SDK's live plugin list can't have changed). List load/render/error
// skeleton lives in list-panel.js (shared with mcp-panel.js); this module
// only owns per-plugin rendering, the toggle, and the reload button (whose
// own error goes to warningEl, not the list, so it stays a separate flow).
import { initListPanel } from '/list-panel.js';

export function initPluginPanel({ listEl, reloadButton, warningEl, fetchPlugins, reloadPlugins, setPluginEnabled }) {
  const panel = initListPanel({
    listEl,
    fetchItems: fetchPlugins,
    renderItem: renderPlugin,
    emptyMessage: 'No plugins loaded.',
    loadingMessage: 'Loading plugins…',
    errorPrefix: 'Could not load plugins',
  });

  if (reloadButton) {
    reloadButton.addEventListener('click', async () => {
      reloadButton.disabled = true;
      reloadButton.textContent = 'Reloading…';
      try {
        const result = await reloadPlugins();
        panel.render(result.plugins || []);
        if (warningEl) {
          if (result.error_count) {
            warningEl.textContent = `${result.error_count} plugin(s) failed to load - see terminal/logs for details.`;
            warningEl.style.display = 'block';
          } else {
            warningEl.style.display = 'none';
          }
        }
      } catch (err) {
        if (warningEl) {
          warningEl.textContent = `Could not reload plugins: ${err.message || err}`;
          warningEl.style.display = 'block';
        }
      } finally {
        reloadButton.disabled = false;
        reloadButton.textContent = 'Reload plugins';
      }
    });
  }

  async function refresh() {
    if (warningEl) warningEl.style.display = 'none';
    await panel.refresh();
  }

  function renderPlugin(plugin) {
    const li = document.createElement('li');
    li.className = 'mcp-server-row';

    const top = document.createElement('div');
    top.className = 'mcp-server-top';

    const name = document.createElement('span');
    name.className = 'cmd-name';
    name.textContent = plugin.version ? `${plugin.name} v${plugin.version}` : plugin.name;

    const source = document.createElement('span');
    source.className = 'cmd-desc';
    source.textContent = plugin.source || 'local path';

    top.append(name, source);

    if (plugin.source) {
      const pluginKey = `${plugin.name}@${plugin.source}`;
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      // Reflects what's actually saved to settings.local.json (server merges
      // this in - see server.js's reload-plugins route), not just "it's
      // loaded right now" - a plugin can be loaded in the live session (SDK
      // read it at startup) while showing disabled here because it was
      // toggled off since, and won't reload on the next session start (B3).
      toggle.checked = plugin.enabled !== false;
      toggle.title = 'Enable/disable this plugin (takes effect next session start)';
      toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        try {
          await setPluginEnabled(pluginKey, toggle.checked);
          showNote(li, 'Takes effect on next session start.');
        } catch (err) {
          toggle.checked = !toggle.checked;
          showNote(li, `Could not save: ${err.message || err}`, true);
        } finally {
          toggle.disabled = false;
        }
      });
      top.prepend(toggle);
    }

    li.append(top);
    return li;
  }

  function showNote(li, message, isError = false) {
    const existing = li.querySelector('.mcp-error, .mcp-note');
    if (existing) existing.remove();
    const note = document.createElement('div');
    note.className = isError ? 'mcp-error' : 'mcp-note';
    note.textContent = message;
    li.append(note);
  }

  return { refresh };
}
