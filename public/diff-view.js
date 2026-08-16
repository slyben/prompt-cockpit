// Diff viewer modal, backed by GET /api/sessions/:id/diff
// (src/sdk-adapter.js's `git diff` fallback - see plan Spike B).

export function initDiffView({ modal, body, closeButton }) {
  closeButton.addEventListener('click', close);

  async function open(sessionId, token) {
    modal.style.display = 'flex';
    body.textContent = 'Loading diff...';
    const res = await fetch(`/api/sessions/${sessionId}/diff`, { headers: { authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.error) {
      body.textContent = `git diff failed: ${data.error}`;
      return;
    }
    render(data.diff);
  }

  function render(diffText) {
    body.innerHTML = '';
    if (!diffText.trim()) {
      body.textContent = 'No changes.';
      return;
    }
    for (const line of diffText.split('\n')) {
      const div = document.createElement('div');
      div.textContent = line;
      if (line.startsWith('+') && !line.startsWith('+++')) div.className = 'diff-add';
      else if (line.startsWith('-') && !line.startsWith('---')) div.className = 'diff-del';
      else if (line.startsWith('@@')) div.className = 'diff-hunk';
      else if (line.startsWith('diff --git') || line.startsWith('index ')) div.className = 'diff-meta';
      body.append(div);
    }
  }

  function close() {
    modal.style.display = 'none';
  }

  return { open, close };
}
