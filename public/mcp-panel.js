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
    reconnectBtn.title = `Reconnect to ${server.name}`;
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
    if (server.status === 'needs-auth' && server.authUrl) {
      // Only appears once session.js's onElicitation has actually caught a
      // URL-mode auth request for this server (see session-registry.js's
      // getMcpServerStatus) - a plain 'needs-auth' status with no link yet
      // means the server hasn't asked, typically because nothing has tried
      // to use it this session. Opens in a new tab since the flow finishes
      // in the browser, not the cockpit - reconnect/refresh afterward (or
      // just wait for the push in the module comment above) to see the
      // badge clear once the SDK reports the server connected.
      const authLink = document.createElement('a');
      authLink.className = 'mcp-auth-link';
      authLink.href = server.authUrl;
      authLink.target = '_blank';
      authLink.rel = 'noopener noreferrer';
      authLink.textContent = 'Authenticate ↗';
      top.append(authLink);
    }
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
    if (server.status === 'needs-auth' && server.authMessage) {
      // Informational (the elicitation's own `message`, e.g. "Please
      // authorize access to continue") - .mcp-note's muted styling, not
      // .mcp-error's red, since needing auth isn't a failure state.
      const authMsg = document.createElement('div');
      authMsg.className = 'mcp-note';
      authMsg.textContent = server.authMessage;
      li.append(authMsg);
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
