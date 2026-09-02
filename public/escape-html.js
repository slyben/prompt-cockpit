// Shared by global-stats-panel.js and stats-panel.js (both cost/token
// display panels that interpolate values into innerHTML) - used to live
// duplicated in each, one DOM-node-textContent trick and one regex map,
// same result. Regex map wins here: no document dependency, so it's usable
// from anywhere this file's imported, not just after the DOM is ready.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
