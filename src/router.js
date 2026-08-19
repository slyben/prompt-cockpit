// Minimal path router for server.js - replaces the hand-rolled sequence of
// `if (url.pathname.match(...) && req.method === ...)` checks that used to
// live directly in handleRequest. Routes are tried in registration order,
// same as those `if` checks were: the first matching {method, pattern} wins.
// No wildcards, no regex patterns in route strings - just literal segments
// and ':name' params, which is all this app's routes ever needed.
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
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
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
