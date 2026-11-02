/**
 * Route-based fetch double for provider adapter tests. Fixtures are built
 * from the shapes in each service's official API docs; no real credentials.
 */
export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

type Responder = (req: RecordedRequest) => Response | Promise<Response>;
type Matcher = string | RegExp | ((url: URL) => boolean);

interface Route {
  method: string;
  match: Matcher;
  respond: Responder;
  remaining: number;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Serve a canned Response repeatedly. (Response.clone() tees the body, and
 * cancelling one tee branch waits for the other — which would make code that
 * correctly calls `res.body.cancel()` hang in tests.)
 */
function replay(template: Response): Responder {
  const body = template.arrayBuffer();
  const nullBody = [101, 204, 205, 304].includes(template.status);
  return async () =>
    new Response(nullBody ? null : (await body).slice(0), { status: template.status, statusText: template.statusText, headers: template.headers });
}

export function mockHttp() {
  const routes: Route[] = [];
  const calls: RecordedRequest[] = [];

  const matches = (m: Matcher, url: URL) =>
    typeof m === 'string' ? url.pathname === m || url.href.split('?')[0] === m : m instanceof RegExp ? m.test(url.href) : m(url);

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    init.signal?.throwIfAborted();
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body === undefined || init.body === null ? null : String(init.body);
    const req: RecordedRequest = { method, url, headers: new Headers(init.headers), body };
    calls.push(req);
    // Later registrations take precedence (lets a test override a default route).
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i]!;
      if (r.remaining === 0 || (r.method !== '*' && r.method !== method) || !matches(r.match, url)) continue;
      if (r.remaining > 0) r.remaining--;
      return r.respond(req);
    }
    throw new Error(`mockHttp: unmatched ${method} ${url.href}`);
  };

  const api = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    /** Register a route. `times` limits how often it matches (default: unlimited). */
    on(method: string, match: Matcher, respond: Responder | Response | object, times = -1) {
      const responder: Responder =
        typeof respond === 'function' ? (respond as Responder) : respond instanceof Response ? replay(respond) : () => json(respond);
      routes.push({ method: method.toUpperCase(), match, respond: responder, remaining: times });
      return api;
    },
    /** Simulate a transport failure (DNS, refused, reset). */
    fail(method: string, match: Matcher, times = -1) {
      return api.on(method, match, () => Promise.reject(new TypeError('fetch failed')), times);
    },
    /** Requests matching a path (for assertions). */
    to(match: Matcher) {
      return calls.filter((c) => matches(match, c.url));
    },
  };
  return api;
}
