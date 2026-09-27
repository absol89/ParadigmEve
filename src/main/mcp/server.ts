/**
 * The local MCP endpoint.
 *
 * Bound to 127.0.0.1 on an ephemeral port, never 0.0.0.0, so nothing on the LAN can
 * reach it. Four independent checks run before any MCP handling:
 *   1. the request path must carry the per-session secret token
 *   2. the Host header must be loopback (DNS rebinding protection)
 *   3. a present Origin header must be loopback (a browser cannot drive this endpoint)
 *   4. the body must be within a sane size
 *
 * The MCP handler is built per request from live config, so toggling a permission in
 * the UI takes effect on the very next call without restarting anything.
 *
 * Two things here exist purely because of what talks to this server. tunnel-client
 * runs OAuth discovery (RFC 9728) against it on every start and decodes whatever
 * comes back as JSON without looking at the status code, so this server answers the
 * protected-resource metadata request properly and never emits a non-JSON body.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createInboundTiming, formatInboundTiming, requestIdFromHeader, withInboundRequestId } from './inbound.js';
import http from 'node:http';
import { createMcpHandler, type ListToolsResult } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { getConfig } from '../config.js';
import { logError, logInfo, logWarn } from '../logger.js';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { buildServer, resetToolClock, type ToolContext } from './tools.js';
import { CORE_CONNECTOR_NAME, SURFACE_IDS, surfaceDefinition, type SurfaceId } from './surfaces.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface McpEndpoint {
  /** Reuses the endpoint's actual exposure projection; no tool handlers are executed. */
  publication?: (surface: SurfaceId, observe: Parameters<typeof buildServer>[2]) => void;
  port: number;
  /**
   * The Core surface's URL, including its secret path segment.
   *
   * Kept as a named field because Core is the connector the app cannot work without and
   * most callers mean exactly it.
   */
  url: string;
  /**
   * One URL per surface, each with its own token.
   *
   * Separate paths rather than separate ports: one listener is simpler to start, stop and
   * firewall, and a public tunnel that publishes the origin publishes both surfaces with no
   * extra process. What matters for the design is not which socket a request arrived on but
   * which MCP server answers it, and each path is wired to exactly one (see `buildServer`).
   */
  urls: Record<SurfaceId, string>;
  /**
   * Stops accepting new requests and drains accepted ones.
   *
   * Ordinary disconnect/reconnect callers omit `forceAfterMs`: severing an active response
   * after its mutation committed creates an ambiguous retry boundary. Final process shutdown
   * may opt into a bounded force because the process is exiting either way.
   */
  stop: (options?: { forceAfterMs?: number }) => Promise<void>;
}

/** RFC 9728 §3.1: the metadata for a resource at /x lives at /.well-known/…/x. */
const PRM_PREFIX = '/.well-known/oauth-protected-resource';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Everything that is not the MCP endpoint answers with JSON.
 *
 * The reason is not tidiness. tunnel-client's OAuth discovery decodes the body of
 * these probes as JSON whatever the status code is, so a plain-text "Not found"
 * surfaced as `invalid character 'N' looking for beginning of value` and left the
 * client's OAuth state permanently in a failed state.
 */
function jsonError(res: http.ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Buffers an HTTP body only when its size is not already bounded by Content-Length.
 *
 * The MCP Node adapter otherwise concatenates a chunked/missing-length request to an
 * unbounded JS string before parsing it. Stop retaining bytes at the same 8 MiB limit the
 * header guard advertises, answer immediately, and drain the remaining socket bytes without
 * keeping them in memory.
 */
function readBoundedJsonBody(
  req: http.IncomingMessage
): Promise<{ body?: unknown; error?: 'payload_too_large' | 'invalid_json' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const finish = (value: { body?: unknown; error?: 'payload_too_large' | 'invalid_json' }): void => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_BODY_BYTES) {
        finish({ error: 'payload_too_large' });
        // Do not leave the unread request applying backpressure to this connection. Its
        // remaining bytes are discarded by Node rather than accumulated by us.
        req.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      try {
        const text = Buffer.concat(chunks, total).toString('utf8');
        finish({ body: text.length === 0 ? undefined : JSON.parse(text) });
      } catch {
        finish({ error: 'invalid_json' });
      }
    };
    const onError = (): void => finish({ error: 'invalid_json' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * RFC 9728 protected resource metadata.
 *
 * This server is not protected by OAuth — the unguessable path token is what
 * authorises a caller — so the document names the resource and lists no
 * authorization server. That is the truthful "no OAuth here" answer, and it is what
 * stops a client from either failing discovery or trying to start an OAuth flow.
 *
 * It is served only at the token-qualified URL. Anyone who can form that URL already
 * knows the token, so the `resource` field gives nothing away; serving it at the bare
 * /.well-known root would hand the token to any local process that asked.
 */
function protectedResourceMetadata(resource: string, resourceName: string): string {
  return JSON.stringify({
    resource,
    resource_name: resourceName,
    authorization_servers: [],
    scopes_supported: []
  });
}

/**
 * When ChatGPT last actually reached this app, epoch ms.
 *
 * This is the only end-to-end proof that exists: the tunnel can be up and OpenAI
 * reachable while ChatGPT still refuses to call the connector, and only a request
 * landing here distinguishes those two.
 */
let requestSeenAt: number | null = null;
/**
 * The same clock per published surface. New setup needs only the primary ParadigmEve clock;
 * the legacy Desktop clock remains useful only while an existing two-app install is migrated.
 */
const surfaceRequestAt = new Map<SurfaceId, number>();
const requestSeenListeners = new Set<() => void>();

export function lastRequestAt(surface?: SurfaceId): number | null {
  if (surface === undefined) return requestSeenAt;
  return surfaceRequestAt.get(surface) ?? null;
}

/**
 * Fires only when a validated non-self-test/non-tunnel-probe request reaches an actual MCP
 * surface. Setup completion uses this edge so its durable result never depends on a later
 * renderer refresh or periodic status repaint.
 */
export function onMcpRequestSeen(listener: () => void): () => void {
  requestSeenListeners.add(listener);
  return () => requestSeenListeners.delete(listener);
}

/**
 * Lets the self-test call this server without being mistaken for ChatGPT.
 *
 * The self-test drives the loopback endpoint over real HTTP, so without this it would
 * set the clock above and turn the one honest end-to-end signal into a green light
 * this app switched on itself. The value is random per session and never leaves the
 * process, so nothing outside can claim to be the self-test.
 */
const SELF_TEST_HEADER = 'x-local-self-test';
const TUNNEL_PROBE_HEADER = 'x-local-tunnel-probe';
let selfTestToken = randomBytes(16).toString('hex');
let tunnelProbeToken = randomBytes(16).toString('hex');

export function selfTestHeaders(): Record<string, string> {
  return { [SELF_TEST_HEADER]: selfTestToken };
}

/** Header injected only into tunnel-client's own discovery/startup probes. */
export function tunnelProbeHeaders(): Record<string, string> {
  return { [TUNNEL_PROBE_HEADER]: tunnelProbeToken };
}

/**
 * Starts the local MCP server.
 *
 * `getContext` is called on every request so that roots and capabilities are read
 * fresh; nothing about the permission state is captured at startup.
 */
interface SurfaceExposure {
  finishTool: boolean;
  caps: ToolContext['caps'] | null;
  sessionTools: boolean;
  agentTools: boolean;
  find: boolean | null;
}

/**
 * What each independently discoverable connector has already exposed.
 *
 * Core and Desktop share one loopback listener, but they are separate MCP servers to the
 * client. Keeping this as one global snapshot let a Desktop request freeze Core's mutually
 * exclusive `find`/exec choice before Core had ever been discovered, and it could similarly
 * preserve Core-only feature exposure solely because the other connector was queried first.
 * Monotonicity therefore has to be per surface, which is the same boundary ChatGPT caches.
 */
const surfaceExposure = new Map<SurfaceId, SurfaceExposure>();

function exposureFor(surface: SurfaceId): SurfaceExposure {
  let state = surfaceExposure.get(surface);
  if (!state) {
    state = { finishTool: false, caps: null, sessionTools: false, agentTools: false, find: null };
    surfaceExposure.set(surface, state);
  }
  return state;
}

/**
 * Clears the process-lifetime dispatch compatibility high-water mark.
 *
 * Production settings/reconnect paths deliberately do NOT call this. ChatGPT may keep a
 * tools/list snapshot in an already-open conversation while the app is publishing a newer,
 * smaller declaration. Dropping a formerly exposed handler before that stale conversation is
 * gone turns an ordinary permission change into JSON-RPC -32602 "Tool not found". The desired
 * declaration is projected separately by `publication` below, so disabled tools can disappear
 * from the next connector schema while old calls are still caught here and refused by live
 * permission guards.
 *
 * Exported for isolated tests (and an explicit future process-boundary reset) only. A real app
 * restart resets this module state naturally.
 */
export function forgetExposedSurface(): void {
  surfaceExposure.clear();
}

export async function startMcpServer(getContext: () => ToolContext): Promise<McpEndpoint> {
  // A per-session token in the path is what authorises callers. It is regenerated on
  // every app start, so a URL that leaks stops working when the app restarts.
  requestSeenAt = null;
  surfaceRequestAt.clear();
  resetToolClock();
  selfTestToken = randomBytes(16).toString('hex');
  tunnelProbeToken = randomBytes(16).toString('hex');
  // One path per surface, each with its own token. Distinct tokens rather than one shared
  // secret because the two connectors are configured separately in ChatGPT and may be
  // shared, revoked or re-pasted at different times; a single token would make "give me
  // Desktop" and "give me everything" the same act.
  const surfacePaths = SURFACE_IDS.map((id) => ({
    id,
    basePath: `/mcp/${id}/${randomBytes(32).toString('base64url')}`
  }));

  // ChatGPT can keep a cached tools/list snapshot beyond an endpoint reconnect. If a permission
  // is disabled after that snapshot was loaded, removing the tool immediately makes the old
  // snapshot call an unknown tool and some clients surface that as a transport-level
  // UNKNOWN/TaskGroup failure. Keep dispatch exposure monotonic for this *process*: newly
  // enabled tools appear, previously exposed tools remain registered, and their handlers return
  // TOOL_DISABLED while the live capability is off. Desired publication is intentionally
  // separate below, so a refreshed connector can still shrink its advertised schema.
  const stableContext = (surface: SurfaceId): ToolContext => {
    const live = getContext();
    const exposed = exposureFor(surface);
    const liveFind = !live.caps.command && live.caps.search;
    if (exposed.find === null) exposed.find = liveFind;
    else if (liveFind) exposed.find = true;
    if (exposed.caps === null) {
      exposed.caps = { ...live.caps };
    } else {
      for (const key of Object.keys(live.caps) as Array<keyof ToolContext['caps']>) {
        if (live.caps[key]) exposed.caps[key] = true;
      }
    }
    const config = getConfig();
    const sessionTools = live.sessionTools ?? config.sessions.record;
    const agentTools = live.agentTools ?? config.multiAgent.enabled;
    exposed.finishTool = exposed.finishTool || config.ui.finishTool === true;
    exposed.sessionTools = exposed.sessionTools || sessionTools;
    exposed.agentTools = exposed.agentTools || agentTools;
    return {
      ...live,
      sessionTools,
      agentTools,
      exposedCaps: { ...exposed.caps },
      exposedSessionTools: exposed.sessionTools,
      exposedFinishTool: exposed.finishTool,
      exposedAgentTools: exposed.agentTools,
      exposedFind: exposed.find
    };
  };

  // One handler per surface, and the routing below is the only thing that decides which
  // one sees a request. This is what makes the discovery boundary real rather than
  // advertised: the Core handler has no `computer` registered at all, so a call for it
  // fails as an unknown tool inside the protocol layer, with nothing here to "helpfully"
  // forward it to the other surface.
  const routes = surfacePaths.map((surface) => ({
    ...surface,
    prmPath: `${PRM_PREFIX}${surface.basePath}`,
    url: '',
    handler: toNodeHandler(
      createMcpHandler(() => {
        // Register the process-lifetime compatibility superset so a tools/call from an already-
        // open conversation always reaches a live permission guard instead of protocol -32602.
        const dispatch = buildServer(
          stableContext(surface.id),
          surface.id,
          undefined,
          () => stableContext(surface.id)
        );

        // But discovery must describe the settings as they are NOW. The SDK normally derives
        // tools/list from every registered handler, coupling discovery to dispatch. Replace only
        // that request handler with a declaration built from the desired live context. This gives
        // refreshed ChatGPT connectors the smaller/current schema while stale tools/call names
        // remain safely dispatchable for the rest of this process.
        dispatch.server.setRequestHandler('tools/list', async () => {
          let desiredTools: PluginToolSchema[] = [];
          const desired = buildServer(getContext(), surface.id, (_name, _version, _instructions, tools) => {
            desiredTools = tools;
          }, getContext);
          await desired.close();
          return { tools: desiredTools as unknown as ListToolsResult['tools'] } as ListToolsResult;
        });
        return dispatch;
      }),
      { onerror: (error) => logError(`MCP handler error (${surface.id}): ${error.message}`) }
    )
  }));
  const checkHost = localhostHostValidation();
  const checkOrigin = localhostOriginValidation();

  const server = http.createServer((req, res) => {
    const timing = createInboundTiming();
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0] ?? '';
    const selfTest = req.headers[SELF_TEST_HEADER] === selfTestToken;
    const tunnelProbe = req.headers[TUNNEL_PROBE_HEADER] === tunnelProbeToken;

    // Logged for every request, so the Activity tab shows what actually arrived and
    // what it was answered with. The path is reduced to a shape — it carries the
    // session token — and nothing from the body is logged.
    const route = routes.find((candidate) => safeEqual(pathOnly, candidate.basePath)) ?? null;
    const prmRoute = routes.find((candidate) => safeEqual(pathOnly, candidate.prmPath)) ?? null;

    const startedAt = Date.now();
    const publication = { completedAt: null as number | null, failed: false };
    res.once('close', () => { if (publication.completedAt === null) publication.failed = true; });
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && !publication.failed) publication.completedAt = Date.now();
      else publication.failed = true;
      const shape = route
        ? `mcp/${route.id}`
        : prmRoute
          ? `oauth-metadata/${prmRoute.id}`
          : pathOnly.slice(0, 40);
      const method = req.method ?? '?';
      const who = selfTest ? ' (self-test)' : tunnelProbe ? ' (tunnel probe)' : '';
      const line = `${method} ${shape} → ${res.statusCode} in ${Date.now() - startedAt}ms${who}${formatInboundTiming(timing)}`;
      // Streamable HTTP makes the server-opened SSE stream and session deletion
      // optional, and 405 is the prescribed answer for a server that offers
      // neither. ChatGPT probes for both on every connect, so treating those two
      // as failures would put a pair of red lines in the log on a healthy
      // connection and bury the errors that do matter.
      const optional =
        res.statusCode === 405 && route !== null && (method === 'GET' || method === 'DELETE');
      const expectedTunnelProbe = tunnelProbe && res.statusCode === 415 && route !== null && method === 'POST';
      if (optional) logInfo(`request ${line} (stream/session not offered — normal)`);
      else if (expectedTunnelProbe) logInfo(`request ${line} (probe compatibility check — normal)`);
      else if (res.statusCode >= 400) logWarn(`request ${line}`);
      else logInfo(`request ${line}`);
    });

    if (prmRoute) {
      if (!checkHost(req, res)) return;
      if (!checkOrigin(req, res)) return;
      const body = protectedResourceMetadata(
        prmRoute.url,
        surfaceDefinition(prmRoute.id, getConfig().mcp?.connectorName ?? CORE_CONNECTOR_NAME).connectorName
      );
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }

    if (!route) {
      jsonError(res, 404, 'not_found');
      return;
    }
    if (!checkHost(req, res)) return;
    if (!checkOrigin(req, res)) return;

    // Count only a validated request to the actual MCP endpoint. OAuth metadata,
    // 404s, our own self-test and tunnel-client's startup initialize probe are not
    // evidence that ChatGPT itself reached the connector.
    if (!selfTest && !tunnelProbe) {
      requestSeenAt = Date.now();
      surfaceRequestAt.set(route.id, requestSeenAt);
      for (const listener of requestSeenListeners) listener();
    }

    const declaredHeader = req.headers['content-length'];
    const declared = Number(declaredHeader ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      jsonError(res, 413, 'payload_too_large');
      return;
    }

    // The tool dispatch reads this back to join the call to the page request that issued
    // it; see inbound.ts for why it cannot be taken from the MCP call context.
    const requestId = requestIdFromHeader(req.headers['x-request-id']);
    if (req.method === 'POST' && declaredHeader === undefined) {
      void readBoundedJsonBody(req).then((parsed) => {
        if (parsed.error === 'payload_too_large') {
          jsonError(res, 413, 'payload_too_large');
          return;
        }
        if (parsed.error === 'invalid_json') {
          jsonError(res, 400, 'invalid_json');
          return;
        }
        withInboundRequestId(
          requestId,
          () => void route.handler(req, res, parsed.body),
          timing,
          publication,
          !selfTest && !tunnelProbe
        );
      });
      return;
    }
    withInboundRequestId(
      requestId,
      () => void route.handler(req, res),
      timing,
      publication,
      !selfTest && !tunnelProbe
    );
  });

  // Reject slow or oversized bodies rather than holding sockets open indefinitely.
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.maxRequestsPerSocket = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not determine the local server port');
  }

  server.on('error', (err) => logError(`Local server error: ${err.message}`));
  logInfo(`server started on 127.0.0.1:${address.port}`);

  // Known only once the OS has handed us a port, and needed by each metadata document as
  // that surface's canonical resource identifier.
  for (const surface of routes) surface.url = `http://127.0.0.1:${address.port}${surface.basePath}`;
  const urls = Object.fromEntries(routes.map((surface) => [surface.id, surface.url])) as Record<SurfaceId, string>;

  return {
    port: address.port,
    url: urls.core,
    urls,
    // Publication describes what a freshly refreshed connector SHOULD advertise now, not the
    // compatibility superset this process still dispatches for already-cached conversations.
    // Using stableContext here previously forced settings code to clear the high-water mark just
    // to make publication shrink, creating a 20s plugin-refresh window where ChatGPT advertised
    // old tools but the live MCP endpoint answered "Tool not found".
    publication: (surface, observe) => {
      // This declaration is what ParadigmEve asks ChatGPT to cache, so it also counts as possible
      // stale-call exposure even though the declaration itself is built from the desired live
      // context rather than the compatibility superset.
      stableContext(surface);
      void buildServer(getContext(), surface, observe).close();
    },
    stop: (options = {}) =>
      new Promise<void>((resolve) => {
        // Stop accepting new work, but let requests already accepted by the MCP adapter
        // finish and deliver their result. Destroying active sockets here created ambiguous
        // commits: the caller saw `fetch failed` and could retry while the original mutation
        // continued in this process. `server.close()` drains active connections. There is no
        // force deadline for an ordinary disconnect/reconnect; only final process shutdown
        // opts into one explicitly, where remaining work cannot outlive the app anyway.
        let settled = false;
        const forceAfterMs = options.forceAfterMs;
        const force =
          forceAfterMs === undefined
            ? null
            : setTimeout(() => {
                if (settled) return;
                // Force first, report second. This timer is the only thing between a wedged
                // peer and a shutdown that never ends, so nothing it depends on may sit behind
                // a call that could throw — and logging reaches the renderer, which by this
                // point in a quit is already gone.
                server.closeAllConnections();
                logWarn(`server drain timed out after ${forceAfterMs}ms during final shutdown; forcing remaining connections closed`);
              }, Math.max(0, forceAfterMs));
        force?.unref?.();
        server.closeIdleConnections?.();
        server.close(() => {
          settled = true;
          if (force) clearTimeout(force);
          logInfo('server stopped');
          resolve();
        });
      })
  };
}
