// Shared load/render/error skeleton for a settings-modal panel that lists
// items fetched from the server (MCP servers, plugins) - mcp-panel.js and
// plugin-panel.js used to hand-roll this exact dance separately (loading
// placeholder -> fetch -> render rows, or replace the list with one error
// row on failure). Each caller still owns its own per-item rendering and any
// row-level actions (toggle, reconnect, ...) - this only factors out the
// list-level plumbing around them.
export function initListPanel({ listEl, fetchItems, renderItem, emptyMessage, loadingMessage, errorPrefix }) {
  async function refresh() {
    listEl.innerHTML = '';
    const loading = document.createElement('li');
    loading.className = 'cmd-desc';
    loading.textContent = loadingMessage;
    listEl.append(loading);
    let items;
    try {
      items = await fetchItems();
    } catch (err) {
      listEl.innerHTML = '';
      const errLi = document.createElement('li');
      errLi.className = 'mcp-error';
      errLi.textContent = `${errorPrefix}: ${err.message || err}`;
      listEl.append(errLi);
      return;
    }
    render(items);
  }

  function render(items) {
    listEl.innerHTML = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'cmd-desc';
      li.textContent = emptyMessage;
      listEl.append(li);
      return;
    }
    for (const item of items) {
      listEl.append(renderItem(item));
    }
  }

  return { refresh, render };
}
