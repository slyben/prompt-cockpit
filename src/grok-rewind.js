// Grok rewind targeting. Cockpit turnIndex is 1-based (session.js).
// Grok rewind points use prompt_index (0-based, one per user prompt).
// Map by order of points, not by assuming prompt_index === turnIndex - 1:
// points can be sparse.

export function resolveGrokPromptIndex(points, turnIndex) {
  if (!Number.isInteger(turnIndex) || turnIndex < 1) {
    throw new Error('turnIndex (1-based integer) required');
  }
  const list = Array.isArray(points) ? points : [];
  const sorted = [...list].sort((a, b) => (a.prompt_index ?? 0) - (b.prompt_index ?? 0));
  const point = sorted[turnIndex - 1];
  if (!point || typeof point.prompt_index !== 'number') {
    throw new Error(`no rewind point for turn #${turnIndex}`);
  }
  return point.prompt_index;
}

export function parseRewindPointsFile(text) {
  const points = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.prompt_index === 'number') {
      points.push({
        prompt_index: entry.prompt_index,
        created_at: entry.created_at || null,
      });
    }
  }
  return points;
}
