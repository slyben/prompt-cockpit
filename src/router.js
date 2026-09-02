// Minimal path router: routes are tried in registration order, first match
// wins. No wildcards or regex in route strings - just literal segments and
// ':name' params.
export function createRouter() {
  const routes = [];

  function compile(pattern) {
    const paramNames = [];
    const regexSource = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1));
          return '([^/]+)';
        }
        // Escape regex-meaningful characters in literal segments (none of
        // this app's routes currently have any, but this is what a static
        // segment is supposed to mean).
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${regexSource}$`), paramNames };
  }

  function add(method, pattern, handler) {
    const { regex, paramNames } = compile(pattern);
    routes.push({ method, regex, paramNames, handler });
  }

  // Registers a handler for every HTTP method on `pattern` - used for
  // /api/sessions/:id/:action, whose single dispatcher (session-actions.js)
  // does its own per-action method checks internally, same as the original
  // handleSessionRoute did.
  function any(pattern, handler) {
    add('ANY', pattern, handler);
  }

  // Returns true if a route matched (and its handler ran), false otherwise -
  // the caller (server.js) falls back to static file serving on false, same
  // as the original handleRequest fell through to serveStatic().
  async function handle(req, res, url) {
    for (const route of routes) {
      if (route.method !== 'ANY' && route.method !== req.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = {};
      try {
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
      } catch (err) {
        // A malformed percent-escape (e.g. a bare "%") throws URIError from
        // decodeURIComponent - that's a client mistake, not a server fault,
        // so answer 400 instead of falling through to server.js's generic
        // 500 catch-all.
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed URL path' }));
        return true;
      }
      await route.handler(req, res, url, params);
      return true;
    }
    return false;
  }

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    any,
    handle,
  };
}
