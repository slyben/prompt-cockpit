// Visible input queue, docked above compose. Unlike task-panel.js there's
// no toggle: it shows itself the moment cockpit:queue has an entry and
// hides itself when empty - an empty queue isn't worth permanent chrome.
// Backend contract: each entry is `{id, text}`; reorder/drop/send-now all
// key off `id`, never position, since position shifts under a fast typer.
export function initQueuePanel({ panel, listEl, onReorder, onRemove, onSendNow }) {
  let queue = [];

  function setQueue(next) {
    queue = next || [];
    panel.hidden = queue.length === 0;
    render();
  }

  function reset() {
    queue = [];
    panel.hidden = true;
    listEl.innerHTML = '';
  }

  function render() {
    listEl.innerHTML = '';
    queue.forEach((entry, i) => listEl.append(renderRow(entry, i)));
  }

  function renderRow(entry, i) {
    const li = document.createElement('li');
    li.className = 'queue-row';

    const text = document.createElement('span');
    text.className = 'queue-text';
    text.textContent = entry.text;
    text.title = entry.text;
    li.append(text);

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn';
    upBtn.textContent = '↑'; // up arrow
    upBtn.title = 'Move earlier';
    upBtn.disabled = i === 0;
    upBtn.addEventListener('click', () => reorderBySwap(i, i - 1));
    li.append(upBtn);

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn';
    downBtn.textContent = '↓'; // down arrow
    downBtn.title = 'Move later';
    downBtn.disabled = i === queue.length - 1;
    downBtn.addEventListener('click', () => reorderBySwap(i, i + 1));
    li.append(downBtn);

    const sendNowBtn = document.createElement('button');
    sendNowBtn.type = 'button';
    sendNowBtn.className = 'btn';
    sendNowBtn.textContent = 'Send now';
    sendNowBtn.title = 'Interrupt the running turn and run this one next';
    sendNowBtn.addEventListener('click', () => onSendNow(entry.id));
    li.append(sendNowBtn);

    const dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'btn';
    dropBtn.textContent = 'Drop';
    dropBtn.title = 'Remove from the queue - never sent';
    dropBtn.addEventListener('click', () => onRemove(entry.id));
    li.append(dropBtn);

    return li;
  }

  // The panel only ever asks the server to reorder the WHOLE queue (simpler
  // contract than a single-item move, and session.js's reorder() already
  // takes a full id list) - this just computes that full list with two
  // entries swapped and sends it, rather than tracking a separate
  // "move this one" verb server-side.
  function reorderBySwap(i, j) {
    if (j < 0 || j >= queue.length) return;
    const ids = queue.map((e) => e.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onReorder(ids);
  }

  return { setQueue, reset };
}
