import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z, ZodError } from 'zod';
import {
  PROTOCOL_VERSION,
  actionSchema,
  capabilitySchema,
  matchesPattern,
  projectIdentitySchema,
  redact,
  type CommandRecord,
  type EventQuery,
  type RippleyEvent,
  type StoredEvent,
  type StreamMessage,
} from '@rippley/blackbox-protocol';
import { ApiError, Store } from './store.js';

export { Store } from './store.js';
export interface DaemonOptions {
  databasePath?: string;
  store?: Store;
  persist?: () => Promise<void>;
  port?: number;
  bindAddress?: string;
  publicOrigin?: string;
  accessToken?: string;
  dashboardPath?: string;
  allowedOrigins?: string[];
  heartbeatTimeoutMs?: number;
  maintenanceIntervalMs?: number;
  commandSweepMs?: number;
}
const MAX_BODY = 2 * 1024 * 1024;
const MAX_SOCKET_BUFFER = 2 * 1024 * 1024;
const identifier = z.string().min(1).max(200);
const commandPayload = z.record(z.unknown()).superRefine((payload, ctx) => {
  if (Object.hasOwn(payload, 'projectId') && !identifier.safeParse(payload.projectId).success)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['projectId'],
      message: 'Invalid project identifier',
    });
});
const commandInput = z.object({
  provider: identifier.optional(),
  command: identifier,
  payload: commandPayload.default({}),
  correlationId: identifier.optional(),
  confirmed: z.boolean().optional(),
  timeoutMs: z.number().int().min(50).max(300000).default(30000),
});
const logInput = z.object({
  source: z.object({ app: identifier, version: z.string().max(1024).optional() }),
  project: projectIdentitySchema.optional(),
  stream: z.enum(['stdout', 'stderr', 'file']).default('stdout'),
  lines: z.union([z.string().max(1024 * 1024), z.array(z.string().max(65536)).max(500)]),
  correlationId: identifier.optional(),
});
const ackInput = z.object({
  appId: identifier,
  status: z.enum(['accepted', 'completed', 'failed']),
  result: z.unknown().optional(),
  error: z.string().max(65536).optional(),
});

export function defaultDatabasePath(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData/Local'))
      : process.platform === 'darwin'
        ? resolve(homedir(), 'Library/Application Support')
        : (process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share'));
  return resolve(base, 'black-box/black-box.db');
}

export function createDaemon(options: DaemonOptions = {}) {
  const store = options.store ?? new Store(options.databasePath ?? process.env.BLACKBOX_DB ?? defaultDatabasePath());
  const publicOrigin = options.publicOrigin ?? process.env.BLACKBOX_PUBLIC_ORIGIN;
  const accessToken = options.accessToken ?? process.env.BLACKBOX_ACCESS_TOKEN;
  const publicHost = publicOrigin ? new URL(publicOrigin).host : undefined;
  if (publicOrigin && (!publicOrigin.startsWith('https://') || !accessToken || accessToken.length < 32))
    throw new Error('Public mode requires an HTTPS origin and an access token of at least 32 characters');
  const bindAddress = options.bindAddress ?? (publicOrigin ? '0.0.0.0' : '127.0.0.1');
  if (bindAddress !== '127.0.0.1' && !publicOrigin)
    throw new Error('Non-loopback binding requires authenticated public mode');
  const configuredPort = options.port ?? Number(process.env.PORT ?? process.env.BLACKBOX_PORT ?? 47821);
  const startedAt = Date.now();
  const peers = new Map<WebSocket, { appId?: string; patterns: string[]; alive: boolean }>();
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? 45000;
  let actualPort = configuredPort;
  let closing = false;
  const dashboardPath = resolve(
    options.dashboardPath ?? resolve(process.cwd(), 'apps/dashboard/dist'),
  );
  const connected = (id: string) => {
    const a = store.application(id);
    return (
      !!a &&
      Date.now() - Date.parse(a.lastHeartbeat) <= heartbeatTimeout &&
      [...peers].some(([socket, peer]) => peer.appId === id && socket.readyState === WebSocket.OPEN)
    );
  };
  const send = (socket: WebSocket, value: StreamMessage) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER) {
      socket.close(1013, 'Consumer is too slow; reconnect with a sequence cursor');
      return;
    }
    socket.send(JSON.stringify(value));
  };
  const broadcast = (events: StoredEvent[]) => {
    for (const event of events)
      for (const [socket, peer] of peers)
        if (peer.patterns.some((pattern) => matchesPattern(event.type, pattern)))
          send(socket, { kind: 'event', event });
  };
  const ingest = (input: unknown) => {
    const result = store.ingest(input);
    broadcast(result.fresh);
    return result.events;
  };
  const saveCommandWithAudit = (command: CommandRecord, omitProject = false) => {
    // Old databases may contain malformed optional context. Audit generation must still
    // allow those commands to reach a terminal state after upgrading/restarting.
    const projectId = identifier.safeParse(command.payload?.projectId);
    const correlationId = identifier.safeParse(command.correlationId);
    const audit = {
      schemaVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: { app: 'black-box', version: '0.1.0' },
      type: `command.${command.status}`,
      severity:
        command.status === 'failed' || command.status === 'timeout'
          ? 'error'
          : command.status === 'completed'
            ? 'success'
            : 'info',
      message: `${String(command.command).slice(0, 200)} ${command.status}`,
      correlationId: correlationId.success ? correlationId.data : undefined,
      project: !omitProject && projectId.success ? { id: projectId.data } : undefined,
      data: {
        commandId: command.id,
        provider: command.provider,
        command: command.command,
        error: command.error,
      },
      tags: ['command-router'],
    };
    const result = store.db.transaction(() => {
      store.saveCommand(command);
      return store.ingest(audit);
    })();
    // Do not notify observers until both the command and its audit event commit.
    broadcast(result.fresh);
  };
  const sweepCommands = () => {
    let changed = false;
    try {
      for (const command of store.expiredCommands()) {
        command.status = 'timeout';
        command.error = 'Provider did not finish before the command deadline';
        try {
          saveCommandWithAudit(command);
          changed = true;
        } catch {
          // A changed project registry cannot strand a historical command forever.
          try {
            saveCommandWithAudit(command, true);
            changed = true;
          } catch {
            console.error('Black Box could not persist a command timeout; it will retry.');
          }
        }
      }
    } catch {
      console.error('Black Box could not read command deadlines; it will retry.');
    }
    if (changed && options.persist)
      void options.persist().catch(() => console.error('Black Box could not checkpoint command timeouts.'));
  };
  const dashboardPort = Number(process.env.BLACKBOX_DASHBOARD_PORT ?? 47822);
  const configuredOrigins = (process.env.BLACKBOX_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = () =>
    new Set([
      `http://127.0.0.1:${actualPort}`,
      `http://localhost:${actualPort}`,
      `http://127.0.0.1:${dashboardPort}`,
      `http://localhost:${dashboardPort}`,
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      ...configuredOrigins,
      ...(options.allowedOrigins ?? []),
      ...(publicOrigin ? [publicOrigin] : []),
    ]);
  const validateRequest = (req: IncomingMessage, allowPublicNavigation = false) => {
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, publicHost].includes(req.headers.host ?? ''))
      throw new ApiError(403, 'Untrusted Host header');
    // The login POST requires the key. Its redirect to the public HTML shell
    // can retain cross-site navigation metadata; API routes remain strict.
    if (allowPublicNavigation) return;
    if (req.headers.origin && !origins().has(req.headers.origin))
      throw new ApiError(403, 'Untrusted Origin');
    if (req.headers['sec-fetch-site'] === 'cross-site' && !req.headers.origin)
      throw new ApiError(403, 'Cross-site requests are not allowed');
  };
  const session = accessToken
    ? createHmac('sha256', accessToken).update('black-box-browser-session-v1').digest('hex')
    : undefined;
  const equal = (left: string, right: string) => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const authenticated = (req: IncomingMessage) => {
    if (!publicOrigin) return true;
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer && accessToken && equal(bearer, accessToken)) return true;
    const cookie = /(?:^|;\s*)blackbox_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    return !!cookie && !!session && equal(cookie, session);
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  const body = async (req: IncomingMessage): Promise<unknown> => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
      throw new ApiError(415, 'Content-Type must be application/json');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY)
      throw new ApiError(413, 'Request exceeds 2 MiB limit');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new ApiError(413, 'Request exceeds 2 MiB limit');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ApiError(400, 'Invalid JSON');
    }
  };
  const getQuery = (params: URLSearchParams): EventQuery => {
    const out: Record<string, string | number> = {};
    for (const key of [
      'q',
      'project',
      'source',
      'type',
      'severity',
      'repo',
      'command',
      'tag',
      'from',
      'to',
      'correlationId',
    ])
      if (params.has(key)) out[key] = params.get(key)!;
    for (const key of ['port', 'pid', 'limit', 'before', 'after'])
      if (params.has(key)) {
        const value = Number(params.get(key));
        if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(400, `Invalid ${key}`);
        out[key] = value;
      }
    if (params.has('order')) {
      const order = params.get('order')!;
      if (!['timestamp', 'sequence'].includes(order))
        throw new ApiError(400, 'order must be timestamp or sequence');
      out.order = order;
    }
    return out;
  };
  const health = () => ({
    status: 'ok',
    version: '0.1.0',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    eventCount: store.count(),
    latestSequence: store.latestSequence(),
    remoteSync: false,
  });

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (publicOrigin) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const sendJson = (status: number, value: unknown) => {
      const softHeartbeat = /^\/(?:api\/)?applications\/[^/]+\/heartbeat$/.test(req.url?.split('?')[0] ?? '');
      if (status < 400 && ['POST', 'PATCH'].includes(req.method ?? '') && !softHeartbeat && options.persist) {
        void options.persist().then(() => json(res, status, value)).catch(() => {
          if (!res.headersSent) json(res, 503, { error: 'Durable storage is unavailable; write was not acknowledged' });
        });
      } else json(res, status, value);
    };
    try {
      const route = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`).pathname;
      const publicNavigation = !!publicOrigin &&
        ((route === '/login' && req.method === 'POST') ||
          ((route === '/' || route === '/login') && ['GET', 'HEAD'].includes(req.method ?? '')));
      validateRequest(req, publicNavigation);
      if (publicOrigin && route === '/login' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BLACK BOX · Sign in</title><style>body{font:16px system-ui;background:#0d1117;color:#e6edf3;min-height:100vh;display:grid;place-items:center;margin:0}main{width:min(360px,90vw)}h1{letter-spacing:.12em}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border-radius:6px}input{background:#161b22;color:white;border:1px solid #48515e}button{background:#d5fb52;border:0;font-weight:700}</style><main><h1>BLACK BOX</h1><p>Enter your access key.</p><form method="post" action="/login"><input type="password" name="token" aria-label="Access key" required autofocus><button>Unlock</button></form></main></html>`);
        return;
      }
      if (publicOrigin && route === '/login' && req.method === 'POST') {
        if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? ''))
          throw new ApiError(415, 'Form encoding required');
        let form = '';
        for await (const chunk of req) {
          form += chunk.toString();
          if (form.length > 4096) throw new ApiError(413, 'Form too large');
        }
        const token = new URLSearchParams(form).get('token') ?? '';
        if (!accessToken || !equal(token, accessToken)) throw new ApiError(401, 'Invalid access key');
        res.writeHead(303, {
          Location: '/',
          'Set-Cookie': `blackbox_session=${session}; HttpOnly; Secure; SameSite=Lax; Path=/`,
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      if (!authenticated(req)) {
        if (req.method === 'GET' && !route.startsWith('/api') && route !== '/stream') {
          res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
          res.end();
        } else sendJson(401, { error: 'Access key required' });
        return;
      }
      if (req.headers.origin && origins().has(req.headers.origin)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
      const parts = path
        .split('/')
        .filter(Boolean)
        .map((p) => decodeURIComponent(p));
      const method = req.method;
      if (method === 'GET' && path === '/health') return sendJson(200, health());
      if (method === 'POST' && path === '/events')
        return sendJson(201, { events: ingest(await body(req)) });
      if (method === 'GET' && path === '/events')
        return sendJson(200, store.query(getQuery(url.searchParams)));
      if (method === 'GET' && parts[0] === 'events' && parts.length === 2) {
        const event = store.event(parts[1]);
        if (!event) throw new ApiError(404, 'Event not found');
        return sendJson(200, { event });
      }
      if (method === 'GET' && parts[0] === 'events' && parts.length === 3 && parts[2] === 'context')
        return sendJson(200, store.context(parts[1]));
      if (method === 'GET' && path === '/projects')
        return sendJson(200, { projects: store.projects() });
      if (method === 'POST' && path === '/projects')
        return sendJson(201, { project: store.registerProject(await body(req)) });
      if (method === 'GET' && parts[0] === 'projects' && parts.length === 2)
        return sendJson(200, store.projectStats(parts[1], connected));
      if (method === 'GET' && (path === '/applications' || path === '/sources'))
        return sendJson(200, { applications: store.applications(connected) });
      if (method === 'POST' && path === '/applications') {
        const app = store.registerApplication(await body(req));
        return sendJson(201, { application: { ...app, connected: connected(app.id) } });
      }
      if (
        method === 'POST' &&
        parts[0] === 'applications' &&
        parts.length === 3 &&
        parts[2] === 'heartbeat'
      ) {
        const input = z
          .object({ health: z.enum(['healthy', 'warning', 'error']).optional() })
          .parse(await body(req));
        const app = store.heartbeat(parts[1], input.health);
        return sendJson(200, { application: { ...app, connected: connected(app.id) } });
      }
      if (method === 'POST' && path === '/capabilities') {
        const input = z
          .object({ appId: identifier, capability: capabilitySchema })
          .parse(await body(req));
        const app = store.application(input.appId);
        if (!app) throw new ApiError(404, 'Application is not registered');
        store.registerApplication({
          ...app,
          capabilities: [
            ...app.capabilities.filter((c) => c.name !== input.capability.name),
            input.capability,
          ],
        });
        return sendJson(201, { capability: redact(input.capability) });
      }
      if (method === 'POST' && path === '/actions') {
        const input = z.object({ appId: identifier, action: actionSchema }).parse(await body(req));
        const app = store.application(input.appId);
        if (!app) throw new ApiError(404, 'Application is not registered');
        if (input.action.provider !== input.appId)
          throw new ApiError(400, 'Actions must name the registering provider');
        store.registerApplication({
          ...app,
          actions: [...app.actions.filter((a) => a.id !== input.action.id), input.action],
        });
        return sendJson(201, { action: redact(input.action) });
      }
      if (method === 'POST' && path === '/commands') {
        const input = commandInput.parse(redact(await body(req)));
        const providers = store
          .applications(connected)
          .filter(
            (a) =>
              a.connected &&
              (!input.provider || a.id === input.provider) &&
              a.capabilities.some((c) => c.name === input.command),
          );
        if (!providers.length)
          throw new ApiError(409, 'No connected application provides this capability');
        if (providers.length > 1)
          throw new ApiError(409, 'Multiple providers offer this capability; specify provider');
        const provider = providers[0];
        const capability = provider.capabilities.find((c) => c.name === input.command)!;
        if (
          (capability.requiresConfirmation ||
            provider.actions.some((a) => a.command === input.command && a.requiresConfirmation)) &&
          !input.confirmed
        )
          throw new ApiError(409, 'Explicit confirmation is required for this command');
        const sockets = [...peers].filter(
          ([socket, peer]) => peer.appId === provider.id && socket.readyState === WebSocket.OPEN,
        );
        if (sockets.length !== 1)
          throw new ApiError(
            409,
            'Provider has multiple active sessions; command routing is ambiguous',
          );
        const now = Date.now();
        const command: CommandRecord = {
          id: randomUUID(),
          provider: provider.id,
          command: input.command,
          payload: input.payload,
          correlationId: input.correlationId ?? randomUUID(),
          status: 'pending',
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + input.timeoutMs).toISOString(),
        };
        saveCommandWithAudit(command);
        if (options.persist) await options.persist();
        send(sockets[0][0], { kind: 'command', command });
        return sendJson(202, { command });
      }
      if (method === 'GET' && parts[0] === 'commands' && parts.length === 2) {
        sweepCommands();
        const command = store.command(parts[1]);
        if (!command) throw new ApiError(404, 'Command not found');
        return sendJson(200, { command });
      }
      if (
        method === 'POST' &&
        parts[0] === 'commands' &&
        parts.length === 3 &&
        parts[2] === 'ack'
      ) {
        const input = ackInput.parse(redact(await body(req)));
        sweepCommands();
        const command = store.command(parts[1]);
        if (!command) throw new ApiError(404, 'Command not found');
        if (command.provider !== input.appId)
          throw new ApiError(403, 'Only the assigned provider may acknowledge a command');
        if (command.status === input.status) return sendJson(200, { command });
        if (!['pending', 'accepted'].includes(command.status))
          throw new ApiError(409, 'Command has already reached a terminal state');
        command.status = input.status;
        command.result = input.result;
        command.error = input.error;
        saveCommandWithAudit(command);
        return sendJson(200, { command });
      }
      if (method === 'POST' && path === '/logs') {
        const input = logInput.parse(await body(req));
        const lines = (
          typeof input.lines === 'string' ? input.lines.split(/\r?\n/) : input.lines
        ).filter((line) => line.trim());
        if (lines.length > 500) throw new ApiError(400, 'Ingest at most 500 log lines per request');
        const events = lines.map((line) => {
          let data: Record<string, unknown> = {};
          let structured: unknown;
          try {
            const value: unknown = JSON.parse(line);
            if (value && typeof value === 'object') {
              data = Array.isArray(value) ? { entries: value } : (value as Record<string, unknown>);
              structured = value;
            }
          } catch {
            /* Plain text logs are valid. */
          }
          const level = String(data.severity ?? data.level ?? '').toLowerCase();
          const severity =
            ({ warn: 'warning', fatal: 'critical', trace: 'debug' } as Record<string, string>)[
              level
            ] ??
            (['debug', 'info', 'success', 'warning', 'error', 'critical'].includes(level)
              ? level
              : input.stream === 'stderr'
                ? 'error'
                : 'info');
          const timestamp =
            typeof data.timestamp === 'string' && Number.isFinite(Date.parse(data.timestamp))
              ? new Date(data.timestamp).toISOString()
              : new Date().toISOString();
          return {
            id: randomUUID(),
            timestamp,
            source: input.source,
            project: input.project,
            type: `log.${input.stream}`,
            severity,
            message:
              typeof data.message === 'string'
                ? data.message
                : typeof data.msg === 'string'
                  ? data.msg
                  : structured !== undefined
                    ? JSON.stringify(redact(structured))
                    : line,
            data,
            correlationId: input.correlationId,
            tags: ['log', input.stream],
            metadata: { stream: input.stream },
          };
        });
        return sendJson(201, { events: events.length ? ingest(events) : [] });
      }
      if (method === 'GET' && path === '/incidents')
        return sendJson(200, { incidents: store.incidents() });
      if (method === 'POST' && path === '/incidents') {
        const input = z
          .object({ eventId: z.string().uuid(), title: z.string().min(1).max(300).optional() })
          .parse(await body(req));
        return sendJson(201, { incident: store.createIncident(input.eventId, input.title) });
      }
      if (method === 'PATCH' && parts[0] === 'incidents' && parts.length === 2) {
        const input = z.object({ status: z.enum(['open', 'resolved']) }).parse(await body(req));
        const incident = store.incident(parts[1]);
        if (!incident) throw new ApiError(404, 'Incident not found');
        incident.status = input.status;
        incident.resolvedAt = input.status === 'resolved' ? new Date().toISOString() : undefined;
        store.saveIncident(incident);
        return sendJson(200, { incident });
      }
      if (method === 'GET' && path === '/settings')
        return sendJson(200, { retention: store.retention() });
      if (method === 'PATCH' && path === '/settings') {
        const input = z.object({ retention: z.unknown() }).parse(await body(req));
        return sendJson(200, { retention: store.setRetention(input.retention) });
      }
      if (method === 'POST' && path === '/maintenance') {
        await body(req);
        return sendJson(200, { deleted: store.cleanup() });
      }
      if (method === 'GET' && path === '/ecosystem')
        return sendJson(200, {
          ...health(),
          applications: store.applications(connected).map((a) => ({
            id: a.id,
            name: a.name,
            version: a.version,
            health: a.health,
            connected: a.connected,
            lastHeartbeat: a.lastHeartbeat,
            capabilities: a.capabilities.map((c) => c.name),
          })),
          projects: store.projects().map((p) => {
            const {
              lastCommand: _command,
              lastDeployment: _deployment,
              ...stats
            } = store.projectStats(p.id, connected).stats;
            return { id: p.id, name: p.name, ...stats };
          }),
          incidents: { open: store.incidents().filter((i) => i.status === 'open').length },
        });
      if (method === 'GET' && path === '/export') {
        const query = getQuery(url.searchParams);
        const snapshot = store.latestSequence();
        store.query({ ...query, limit: 1 }, true);
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': 'attachment; filename="black-box-events.ndjson"',
          'Cache-Control': 'no-store',
        });
        let cursor = query.after ?? 0;
        while (!res.destroyed) {
          const events = store.query(
            {
              ...query,
              after: cursor,
              before: Math.min(query.before ?? snapshot + 1, snapshot + 1),
              limit: 500,
            },
            true,
          ).events;
          if (!events.length) break;
          for (const e of events) {
            if (res.destroyed) break;
            if (!res.write(`${JSON.stringify(e)}\n`))
              await new Promise<void>((resolve) => {
                const done = () => {
                  res.removeListener('drain', done);
                  res.removeListener('close', done);
                  resolve();
                };
                res.once('drain', done);
                res.once('close', done);
              });
          }
          cursor = events.at(-1)!.sequence;
        }
        res.end();
        return;
      }
      if ((method === 'GET' || method === 'HEAD') && !url.pathname.startsWith('/api')) {
        const requested = resolve(dashboardPath, `.${decodeURIComponent(url.pathname)}`);
        if (requested !== dashboardPath && !requested.startsWith(dashboardPath + sep))
          throw new ApiError(403, 'Invalid asset path');
        let asset = requested;
        if (!existsSync(asset) || !statSync(asset).isFile())
          asset = resolve(dashboardPath, 'index.html');
        if (existsSync(asset)) {
          const mime: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff2': 'font/woff2',
            '.ico': 'image/x-icon',
            '.json': 'application/json',
          };
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
          );
          res.writeHead(200, {
            'Content-Type': mime[extname(asset)] ?? 'application/octet-stream',
            'Cache-Control': extname(asset) === '.html' ? 'no-cache' : 'public, max-age=3600',
          });
          if (method === 'HEAD') res.end();
          else
            createReadStream(asset)
              .on('error', () => res.destroy())
              .pipe(res);
          return;
        }
      }
      throw new ApiError(404, 'Route not found');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        error instanceof ApiError
          ? error.status
          : error instanceof ZodError || error instanceof URIError
            ? 400
            : 500;
      const message =
        error instanceof ZodError
          ? error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.code}`).join('; ')
          : error instanceof ApiError
            ? error.message
            : status === 400
              ? 'Malformed request path'
              : 'Internal server error';
      sendJson(status, { error: message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      validateRequest(req);
      if (!authenticated(req)) throw new ApiError(401, 'Access key required');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      if (!['/stream', '/api/stream'].includes(url.pathname))
        throw new ApiError(404, 'Unknown stream route');
      const appId = url.searchParams.get('appId') || undefined;
      if (appId && !store.application(appId))
        throw new ApiError(404, 'Application is not registered');
      const patterns = (url.searchParams.get('patterns') || '*').split(',');
      if (
        patterns.length > 100 ||
        patterns.some((p) => p.length > 200 || !/^[a-zA-Z0-9_.*-]+$/.test(p))
      )
        throw new ApiError(400, 'Invalid subscription patterns');
      const since = url.searchParams.has('since')
        ? Number(url.searchParams.get('since'))
        : undefined;
      if (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
        throw new ApiError(400, 'Invalid replay cursor');
      wss.handleUpgrade(req, socket, head, (ws) => {
        peers.set(ws, { appId, patterns, alive: true });
        if (appId) store.heartbeat(appId);
        ws.on('close', () => peers.delete(ws));
        ws.on('error', () => peers.delete(ws));
        ws.on('pong', () => {
          const peer = peers.get(ws);
          if (peer) {
            peer.alive = true;
            if (appId) store.heartbeat(appId);
          }
        });
        ws.on('message', () =>
          send(ws, {
            kind: 'error',
            message: 'Use the HTTP API for publishing and acknowledgements',
          }),
        );
        const latest = store.latestSequence();
        send(ws, { kind: 'ready', latestSequence: latest });
        if (since !== undefined) {
          let cursor = since;
          while (
            cursor < latest &&
            ws.readyState === WebSocket.OPEN &&
            ws.bufferedAmount <= MAX_SOCKET_BUFFER
          ) {
            const events = store.query(
              { after: cursor, before: latest + 1, limit: 500 },
              true,
            ).events;
            if (!events.length) break;
            for (const event of events)
              if (patterns.some((pattern) => matchesPattern(event.type, pattern)))
                send(ws, { kind: 'event', event, replay: true });
            cursor = events.at(-1)!.sequence;
          }
          if (cursor < latest)
            ws.close(1013, 'Replay buffer full; reconnect from your last received sequence');
        }
      });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    }
  });
  const sweep = setInterval(sweepCommands, options.commandSweepMs ?? 250);
  const maintenance = setInterval(() => {
    const deleted = store.cleanup();
    if (deleted && options.persist)
      void options.persist().catch(() => console.error('Black Box storage checkpoint failed.'));
  }, options.maintenanceIntervalMs ?? 3600000);
  const ping = setInterval(
    () => {
      for (const [ws, peer] of peers) {
        if (!peer.alive) {
          ws.terminate();
          peers.delete(ws);
        } else {
          peer.alive = false;
          ws.ping();
        }
      }
    },
    Math.min(15000, Math.max(1000, heartbeatTimeout / 3)),
  );
  sweep.unref();
  maintenance.unref();
  ping.unref();
  if (store.cleanup() && options.persist)
    void options.persist().catch(() => console.error('Black Box startup cleanup checkpoint failed.'));
  sweepCommands();
  return {
    store,
    server,
    get url() {
      return publicOrigin ?? `http://127.0.0.1:${actualPort}`;
    },
    async listen(): Promise<string> {
      if (!server.listening)
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(configuredPort, bindAddress, () => {
            server.removeListener('error', reject);
            const address = server.address();
            if (address && typeof address !== 'string') actualPort = address.port;
            resolve();
          });
        });
      return publicOrigin ?? `http://127.0.0.1:${actualPort}`;
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      clearInterval(sweep);
      clearInterval(maintenance);
      clearInterval(ping);
      for (const socket of peers.keys()) socket.terminate();
      peers.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening)
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      if (options.persist) await options.persist();
      store.db.close();
    },
  };
}
