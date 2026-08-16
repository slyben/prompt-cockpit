// Settings modal's MCP servers section. Poll-on-open only (fetchStatus is
// called from refresh(), which the settings modal calls when it opens and
// the panel's own refresh button calls too) - mcpServerStatus() is pull-only,
// there's no server-pushed event for a dropped connection or a needs-auth
// server finishing auth externally, so a timer would just be busywork
// between opens. List load/render/error skeleton lives in list-panel.js
// (shared with plugin-panel.js); this module only owns per-server rendering
// and the toggle/reconnect actions.
import { initListPanel } from '/list-panel.js';

export function initMcpPanel({ listEl, refreshButton, fetchStatus, toggleServer, reconnectServer }) {
  const panel = initListPanel({
    listEl,
    fetchItems: fetchStatus,
    renderItem: renderServer,
    emptyMessage: 'No MCP servers configured.',
    loadingMessage: 'Loading MCP servers…',
    errorPrefix: 'Could not load MCP servers',
  });

  if (refreshButton) refreshButton.addEventListener('click', () => panel.refresh());

  function renderServer(server) {
    const li = document.createElement('li');
    li.className = 'mcp-server-row';

    const top = document.createElement('div');
    top.className = 'mcp-server-top';

    const name = document.createElement('span');
    name.className = 'cmd-name';
    name.textContent = server.name;

    const badge = document.createElement('span');
    badge.className = `mcp-status mcp-status-${server.status}`;
    badge.textContent = server.statusLabel || server.status;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = server.status !== 'disabled';
    toggle.title = toggle.checked ? 'Disable server' : 'Enable server';
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        await toggleServer(server.name, toggle.checked);
        await panel.refresh();
      } catch (err) {
        toggle.checked = !toggle.checked; // revert the optimistic flip
        toggle.disabled = false;
        showInlineError(li, `Could not ${toggle.checked ? 'disable' : 'enable'} ${server.name}: ${err.message || err}`);
      }
    });

    const reconnectBtn = document.createElement('button');
    reconnectBtn.type = 'button';
    reconnectBtn.className = 'mcp-reconnect-btn';
    reconnectBtn.textContent = 'Reconnect';
    reconnectBtn.addEventListener('click', async () => {
      reconnectBtn.disabled = true;
      reconnectBtn.textContent = 'Reconnecting…';
      try {
        await reconnectServer(server.name);
        await panel.refresh();
      } catch (err) {
        reconnectBtn.disabled = false;
        reconnectBtn.textContent = 'Reconnect';
        showInlineError(li, `Could not reconnect ${server.name}: ${err.message || err}`);
      }
    });

    top.append(toggle, name, badge);
    if (server.canReconnect !== false) top.append(reconnectBtn);
    if (server.source) {
      const source = document.createElement('span');
      source.className = 'cmd-desc';
      source.textContent = server.source;
      top.append(source);
    }
    li.append(top);

    if (server.status === 'failed' && server.error) {
      const errLine = document.createElement('div');
      errLine.className = 'mcp-error';
      errLine.textContent = server.error;
      li.append(errLine);
    }

    return li;
  }

  function showInlineError(li, message) {
    const existing = li.querySelector('.mcp-error');
    if (existing) existing.remove();
    const errLine = document.createElement('div');
    errLine.className = 'mcp-error';
    errLine.textContent = message;
    li.append(errLine);
  }

  return { refresh: panel.refresh };
}
