// Read-only transcript routes (live or past session, either provider) plus
// the past-session rename route that has no live registry row to key off.
// Split out of server.js unchanged (behavior-wise) into its own route module.
import { messagesToMarkdown } from '../transcript-markdown.js';
import { setSessionTitle } from '../session-titles.js';
import { isValidCwd } from '../session-launcher.js';
import { respondJson, readJsonBody } from '../http-utils.js';
import { findSubagentTranscript, readSubagentTranscript } from '../agent-transcript.js';
import { parseProvider } from '../provider-registry.js';
import { isSafeSessionId } from '../safe-id.js';

export function registerHistoryRoutes(router) {
  router.get('/api/history/:id', async (req, res, url, { id }) => {
    // No per-session token like the live-session routes, since there's no
    // registry row to hold one for a session this cockpit process never
    // started. Same auth boundary as /api/resumable and /api/browse:
    // Origin/Host only, checked once for every request in server.js - not
    // token-gated (see session-launcher.js's listDirectory comment for why
    // that matters more for /api/browse, which can enumerate the whole
    // filesystem).
    // isSafeSessionId is where Claude's/Grok's own fetchHistory already
    // validate `id` before path.join'ing it onto disk (session-history.js/
    // grok-history.js) - Codex's fetchCodexSessionHistory never did (it
    // passes threadId straight through to the app-server's own RPC, not a
    // local path.join, but there is no reason this route's own boundary
    // should depend on which provider happens to be safe today). Checked
    // once here for every provider instead (2026-09-02 review, "Tests and
    // security" section).
    if (!isSafeSessionId(id)) return respondJson(res, 400, { error: 'invalid session id' });
    const cwd = url.searchParams.get('cwd') || process.cwd();
    let provider;
    try {
      provider = parseProvider(url.searchParams.get('provider'));
    } catch (err) {
      return respondJson(res, 400, { error: err.message });
    }
    try {
      const messages = await provider.fetchHistory(id, cwd);
      return respondJson(res, 200, { messages });
    } catch (err) {
      return respondJson(res, 404, { error: String(err.message || err) });
    }
  });

  router.get('/api/history/:id/markdown', async (req, res, url, { id }) => {
    // Same auth boundary and cwd/provider handling as the JSON route above -
    // this is that same read, just formatted for the "export .md" button
    // (app.js/history-pane.js) instead of the live stream renderer.
    if (!isSafeSessionId(id)) return respondJson(res, 400, { error: 'invalid session id' });
    const cwd = url.searchParams.get('cwd') || process.cwd();
    let provider;
    try {
      provider = parseProvider(url.searchParams.get('provider'));
    } catch (err) {
      return respondJson(res, 400, { error: err.message });
    }
    try {
      const messages = await provider.fetchHistory(id, cwd);
      const markdown = messagesToMarkdown(messages, {
        title: `Session transcript - ${id}`,
        cwd,
        sessionId: id,
        assistantLabel: provider.label,
      });
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        // isSafeSessionId above already rejects path separators, but not a
        // stray `"` that could break out of the quoted filename attribute -
        // belt-and-suspenders strip it too rather than assume every id a
        // provider ever mints is quote-free (2026-09-02 review).
        'content-disposition': `attachment; filename="session-${id.replace(/"/g, '')}.md"`,
      });
      return res.end(markdown);
    } catch (err) {
      return respondJson(res, 404, { error: String(err.message || err) });
    }
  });

  router.get('/api/history/:id/agent/:toolUseId', async (req, res, url, { id, toolUseId }) => {
    // Backs public/detail-pane.js's Agent tab, which polls this for an Agent
    // (Task) tool row - `id` here is the *parent* session's claudeSessionId
    // (app.js's currentClaudeSessionId at click time), not this cockpit's
    // own registry id. Same auth boundary as /api/history/:id above: no
    // session token, since a subagent transcript on disk outlives the tab
    // (and often the live registry row) that spawned it - Origin/Host only.
    try {
      const found = await findSubagentTranscript(id, toolUseId);
      if (!found) return respondJson(res, 404, { error: 'no subagent transcript found for this tool call' });
      const { messages, mtimeMs } = await readSubagentTranscript(found.transcriptPath);
      return respondJson(res, 200, { meta: found.meta, messages, mtimeMs });
    } catch (err) {
      return respondJson(res, 404, { error: String(err.message || err) });
    }
  });

  router.post('/api/session-title', async (req, res) => {
    // Renames a *past* session from the resume list, where there's no live
    // registry row (and so no session token) to gate on - same Origin/Host-
    // only boundary as /api/history above. isValidCwd guards against an
    // arbitrary path being used to probe/write outside a real project.
    const body = await readJsonBody(req);
    const cwd = typeof body.cwd === 'string' ? body.cwd : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!isValidCwd(cwd)) return respondJson(res, 400, { error: `not a directory: ${cwd}` });
    if (!sessionId) return respondJson(res, 400, { error: 'sessionId is required' });
    try {
      await setSessionTitle(cwd, sessionId, body.title);
      return respondJson(res, 200, { title: (body.title || '').trim().slice(0, 120) || null });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  });
}
