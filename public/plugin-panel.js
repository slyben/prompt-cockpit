// Settings modal's Plugins section. Unlike mcp-panel.js there's no live
// enable/disable on Query - only a read-only list (reloadPlugins()) and a
// settings.local.json flag that takes effect next session start, not
// immediately. The toggle writes that flag without touching the running
// session; reload button's own errors go to warningEl, not the list.
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
            warningEl.hidden = false;
          } else {
            warningEl.hidden = true;
          }
        }
      } catch (err) {
        if (warningEl) {
          warningEl.textContent = `Could not reload plugins: ${err.message || err}`;
          warningEl.hidden = false;
        }
      } finally {
        reloadButton.disabled = false;
        reloadButton.textContent = 'Reload plugins';
      }
    });
  }

  async function refresh() {
    if (warningEl) warningEl.hidden = true;
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
      // Reflects what's saved to settings.local.json, not "loaded right now" -
      // a plugin can be loaded in the live session (SDK read it at startup)
      // while showing disabled here because it was toggled off since, and
      // won't reload until the next session start.
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
