import {
  DEFAULT_ENDPOINT,
  PROTOCOL_VERSION,
  applicationSchema,
  capabilitySchema,
  actionSchema,
  eventSchema,
  projectSchema,
  redact,
  redactText,
  matchesPattern,
  type ApplicationRegistration,
  type Capability,
  type CommandInput,
  type CommandRecord,
  type EventAction,
  type EventInput,
  type EventQuery,
  type ProjectIdentity,
  type ProjectRecord,
  type QueryResult,
  type RippleyEvent,
  type StoredEvent,
  type StreamMessage,
} from '@rippley/blackbox-protocol';

const MAX_EVENT_BYTES = 1024 * 1024;
// Leave room for array punctuation and transport framing below the daemon's 2 MiB body cap.
const MAX_BATCH_BYTES = 2 * 1024 * 1024 - 1024;

export type {
  Capability,
  CommandInput,
  CommandRecord,
  EventAction,
  EventInput,
  EventQuery,
  ProjectIdentity,
  ProjectRecord,
  RippleyEvent,
  StoredEvent,
} from '@rippley/blackbox-protocol';
export interface StreamOptions {
  appId: string;
  patterns: string[];
  since: number;
}
export interface StreamCallbacks {
  open(): void;
  message(message: StreamMessage): void;
  close(): void;
  error(error: unknown): void;
}
export interface StreamConnection {
  close(): void;
}
/** Implement these two methods to replace HTTP/WebSocket with a local socket transport. */
export interface BlackBoxTransport {
  request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>;
  connect(
    options: StreamOptions,
    callbacks: StreamCallbacks,
  ): Promise<StreamConnection> | StreamConnection;
  close?(): void;
}
function background(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}
function safely(callback: (() => unknown) | undefined): void {
  try {
    if (callback) void Promise.resolve(callback()).catch(() => {});
  } catch {
    /* observers cannot break the host */
  }
}
function errorMessage(error: unknown): string {
  try {
    return redactText(error instanceof Error ? error.message : String(error));
  } catch {
    return 'Black Box operation failed';
  }
}

export interface HttpTransportOptions {
  endpoint?: string;
  accessToken?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
/** Local HTTP + WS transport. Nothing is sent to a remote service by default. */
export function createHttpTransport(options: HttpTransportOptions = {}): BlackBoxTransport {
  const endpoint = (
    options.endpoint ??
    (typeof process !== 'undefined' ? process.env.BLACKBOX_URL : undefined) ??
    DEFAULT_ENDPOINT
  ).replace(/\/$/, '');
  const timeoutMs = Math.max(100, options.timeoutMs ?? 2_000);
  const accessToken = options.accessToken ?? (typeof process !== 'undefined' ? process.env.BLACKBOX_ACCESS_TOKEN : undefined);
  const connections = new Set<StreamConnection>();
  const controllers = new Set<AbortController>();
  let closed = false;
  return {
    async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      if (closed) throw new Error('Transport closed');
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      background(timer);
      try {
        const response = await (options.fetch ?? globalThis.fetch)(`${endpoint}${path}`, {
          method,
          headers: {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text();
          throw Object.assign(
            new Error(`Black Box HTTP ${response.status}: ${redactText(detail).slice(0, 500)}`),
            { status: response.status },
          );
        }
        return (await response.json()) as T;
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    },
    async connect(options, callbacks) {
      if (closed) throw new Error('Transport closed');
      const url = new URL(`${endpoint}/stream`);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('appId', options.appId);
      url.searchParams.set('patterns', options.patterns.join(','));
      url.searchParams.set('since', String(options.since));
      const isNode = typeof process !== 'undefined' && !!process.versions?.node;
      // Node 20 has no native WebSocket. ws also lets us unref the connection in Node.
      const Ws = isNode ? (await import('ws')).default : globalThis.WebSocket;
      if (closed) throw new Error('Transport closed');
      const socket = isNode
        ? new (Ws as typeof import('ws').default)(url, {
            handshakeTimeout: timeoutMs,
            headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
          })
        : new (Ws as typeof WebSocket)(url);
      let ended = false;
      const connection: StreamConnection = {
        close() {
          ended = true;
          connections.delete(connection);
          try {
            if (isNode) (socket as import('ws').default).terminate();
            else socket.close();
          } catch {
            /* already closed */
          }
        },
      };
      connections.add(connection);
      socket.addEventListener('open', () => {
        if (ended) return;
        if (isNode) (socket as unknown as { _socket?: { unref(): void } })._socket?.unref();
        safely(callbacks.open);
      });
      socket.addEventListener('message', (event: { data: unknown }) => {
        if (ended) return;
        try {
          const message = JSON.parse(String(event.data)) as StreamMessage;
          safely(() => callbacks.message(message));
        } catch (error) {
          safely(() => callbacks.error(error));
        }
      });
      socket.addEventListener('error', (event: unknown) => {
        if (!ended) safely(() => callbacks.error(event));
      });
      socket.addEventListener('close', () => {
        connections.delete(connection);
        if (!ended) safely(callbacks.close);
      });
      return connection;
    },
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      for (const connection of connections) connection.close();
    },
  };
}

export interface ClientOptions {
  app: string;
  name?: string;
  version?: string;
  instanceId?: string;
  endpoint?: string;
  transport?: BlackBoxTransport;
  project?: ProjectIdentity;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Zero disables offline buffering. Defaults to 500 events / 2 MiB / 5 minutes. */
  queueLimit?: number;
  queueMaxBytes?: number;
  queueTtlMs?: number;
  onError?: (error: Error) => unknown;
}
export type EmitDetails = Omit<EventInput, 'type' | 'source'> & Record<string, unknown>;
export type CapabilityInput = Omit<Capability, 'requiresConfirmation'> & {
  requiresConfirmation?: boolean;
};
export type ActionInput = Omit<EventAction, 'payload' | 'requiresConfirmation'> & {
  payload?: Record<string, unknown>;
  requiresConfirmation?: boolean;
};
export type ProjectInput = Pick<ProjectRecord, 'id' | 'name'> &
  Partial<Omit<ProjectRecord, 'id' | 'name'>>;
export type CommandHandler = (
  payload: Record<string, unknown>,
  command: Readonly<CommandRecord>,
) => unknown | Promise<unknown>;
export interface ClientStats {
  connected: boolean;
  queued: number;
  queuedBytes: number;
  dropped: number;
  lastError?: string;
}
interface QueueEntry {
  event: RippleyEvent;
  at: number;
  bytes: number;
}
interface Subscription {
  pattern: string;
  handler: (event: StoredEvent) => unknown;
}

export class BlackBoxClient {
  private readonly options: ClientOptions;
  private readonly transport: BlackBoxTransport;
  private registration: ApplicationRegistration;
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly handledCommands = new Set<string>();
  private readonly seenEvents = new Set<string>();
  private queue: QueueEntry[] = [];
  private queueBytes = 0;
  private dropped = 0;
  private lastError?: string;
  private connected = false;
  private closed = false;
  private sequence = 0;
  private reconnectAttempt = 0;
  private generation = 0;
  private connection?: StreamConnection;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<number>;
  private connecting?: Promise<void>;

  constructor(options: ClientOptions) {
    this.options = options;
    this.transport =
      options.transport ??
      createHttpTransport({ endpoint: options.endpoint, timeoutMs: options.requestTimeoutMs });
    // Even invalid configuration should not throw inside a host application.
    this.registration = {
      id: options.app,
      name: options.name ?? options.app,
      version: options.version ?? '0.0.0',
      instanceId: options.instanceId,
      capabilities: [],
      subscriptions: [],
      actions: [],
      health: 'healthy',
    };
    void this.connect();
    if ((options.heartbeatMs ?? 15_000) > 0) {
      this.heartbeatTimer = setInterval(
        () => {
          void this.heartbeat();
          void this.flush();
        },
        Math.max(100, options.heartbeatMs ?? 15_000),
      );
      background(this.heartbeatTimer);
    }
  }

  get appId(): string {
    return this.registration.id;
  }

  get stats(): ClientStats {
    this.expireQueue();
    return {
      connected: this.connected,
      queued: this.queue.length,
      queuedBytes: this.queueBytes,
      dropped: this.dropped,
      lastError: this.lastError,
    };
  }

  private report(error: unknown): void {
    this.lastError = errorMessage(error);
    safely(() => this.options.onError?.(new Error(this.lastError)));
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T | undefined> {
    if (this.closed) return undefined;
    try {
      return await this.transport.request<T>(method, path, body);
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private async register(): Promise<boolean> {
    try {
      const parsed = applicationSchema.parse(this.registration);
      const response = await this.call('POST', '/applications', redact(parsed));
      if (!response) return false;
      for (const project of this.projects.values()) await this.call('POST', '/projects', project);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private connect(): Promise<void> {
    if (this.closed || this.connection) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!(await this.register()) || this.closed) {
        this.retry();
        return;
      }
      const generation = ++this.generation;
      try {
        const connection = await this.transport.connect(
          {
            appId: this.registration.id,
            patterns: [...new Set([...this.subscriptions].map((s) => s.pattern))],
            since: this.sequence,
          },
          {
            open: () => {
              if (this.closed || generation !== this.generation) return;
              this.connected = true;
              this.reconnectAttempt = 0;
              void this.register();
              void this.flush();
            },
            message: (message) => {
              if (!this.closed && generation === this.generation) this.receive(message);
            },
            close: () => {
              if (generation !== this.generation || this.closed) return;
              this.connected = false;
              this.connection = undefined;
              this.retry();
            },
            error: (error) => {
              if (generation !== this.generation || this.closed) return;
              this.report(error);
              this.disconnect();
              this.retry();
            },
          },
        );
        if (this.closed || generation !== this.generation) connection.close();
        else this.connection = connection;
      } catch (error) {
        this.report(error);
        this.retry();
      }
    })()
      .catch((error) => this.report(error))
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private disconnect(): void {
    ++this.generation;
    this.connected = false;
    try {
      this.connection?.close();
    } catch (error) {
      this.report(error);
    }
    this.connection = undefined;
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return;
    const minimum = Math.max(10, this.options.reconnectMinMs ?? 500);
    const maximum = Math.max(minimum, this.options.reconnectMaxMs ?? 30_000);
    const delay = Math.min(maximum, minimum * 2 ** Math.min(this.reconnectAttempt++, 16));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
      void this.flush();
    }, delay);
    background(this.retryTimer);
  }

  private receive(message: StreamMessage): void {
    try {
      if (message.kind === 'event') {
        const event = message.event;
        if (
          !event ||
          !Number.isSafeInteger(event.sequence) ||
          typeof event.id !== 'string' ||
          typeof event.type !== 'string'
        )
          return;
        this.sequence = Math.max(this.sequence, event.sequence);
        if (this.seenEvents.has(event.id)) return;
        this.seenEvents.add(event.id);
        if (this.seenEvents.size > 2_000)
          this.seenEvents.delete(this.seenEvents.values().next().value!);
        for (const subscription of this.subscriptions) {
          if (matchesPattern(event.type, subscription.pattern)) {
            try {
              void Promise.resolve(subscription.handler(event)).catch((error) =>
                this.report(error),
              );
            } catch (error) {
              this.report(error);
            }
          }
        }
      } else if (
        message.kind === 'command' &&
        !(message as StreamMessage & { replay?: boolean }).replay
      ) {
        void this.handleCommand(message.command).catch((error) => this.report(error));
      } else if (message.kind === 'error') this.report(message.message);
      // A ready cursor is informational: replay follows it and must not be skipped.
    } catch (error) {
      this.report(error);
    }
  }

  private async handleCommand(command: CommandRecord): Promise<void> {
    if (
      !command ||
      command.provider !== this.registration.id ||
      this.handledCommands.has(command.id)
    )
      return;
    const expiresAt = Date.parse(command.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || command.status !== 'pending')
      return;
    this.handledCommands.add(command.id);
    if (this.handledCommands.size > 2_000)
      this.handledCommands.delete(this.handledCommands.values().next().value!);
    const handler = this.handlers.get(command.command);
    const ack = (status: 'accepted' | 'completed' | 'failed', rest: Record<string, unknown> = {}) =>
      this.call<{ command: CommandRecord }>(
        'POST',
        `/commands/${encodeURIComponent(command.id)}/ack`,
        redact({ appId: this.registration.id, status, ...rest }),
      );
    if (!handler) {
      await ack('failed', { error: 'No handler registered for this capability' });
      return;
    }
    const accepted = await ack('accepted');
    // Executing requires a successful acceptance acknowledgement from the router.
    if (!accepted || accepted.command?.status !== 'accepted') return;
    try {
      const result = redact(await handler(command.payload, Object.freeze({ ...command })));
      JSON.stringify(result); // fail closed if a provider returned an unserializable result
      await ack('completed', { result });
    } catch (error) {
      await ack('failed', { error: errorMessage(error) });
    }
  }

  private expireQueue(): void {
    const ttl = Math.max(0, this.options.queueTtlMs ?? 300_000);
    while (this.queue.length && this.queue[0].at + ttl <= Date.now()) {
      this.queueBytes -= this.queue.shift()!.bytes;
      ++this.dropped;
    }
  }

  /** Resolves true when accepted into the bounded memory queue, not when persisted. */
  async publish(input: EventInput): Promise<boolean> {
    if (this.closed) return false;
    try {
      const event = eventSchema.parse(
        redact({
          ...input,
          schemaVersion: input.schemaVersion ?? PROTOCOL_VERSION,
          id: input.id ?? globalThis.crypto.randomUUID(),
          timestamp: input.timestamp ?? new Date().toISOString(),
          source: input.source ?? {
            app: this.options.app,
            version: this.options.version,
            instanceId: this.options.instanceId,
          },
          project: input.project ?? this.options.project,
          message: input.message ?? input.type,
        }),
      );
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (bytes > MAX_EVENT_BYTES) {
        ++this.dropped;
        this.report(new Error('Event exceeds the SDK 1 MiB per-event limit'));
        return false;
      }
      const limit = Math.max(0, this.options.queueLimit ?? 500);
      const maxBytes = Math.max(0, this.options.queueMaxBytes ?? 2 * 1024 * 1024);
      this.expireQueue();
      if (!limit) {
        const sent = !!(await this.call('POST', '/events', [event]));
        if (!sent) ++this.dropped;
        return sent;
      }
      if (bytes > maxBytes) {
        ++this.dropped;
        this.report(new Error('Event exceeds the configured offline queue byte budget'));
        return false;
      }
      while (this.queue.length >= limit || this.queueBytes + bytes > maxBytes) {
        this.queueBytes -= this.queue.shift()!.bytes;
        ++this.dropped;
      }
      this.queue.push({ event, bytes, at: Date.now() });
      this.queueBytes += bytes;
      void this.flush();
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  /** Envelope fields stay at the top level; additional fields become event.data. */
  emit(type: string, details: EmitDetails = {}): Promise<boolean> {
    try {
      const {
        id,
        timestamp,
        schemaVersion,
        severity,
        message,
        project,
        correlationId,
        parentEventId,
        tags,
        metadata,
        actions,
        data,
        ...payload
      } = details;
      return this.publish({
        type,
        id,
        timestamp,
        schemaVersion,
        severity,
        message,
        project,
        correlationId,
        parentEventId,
        tags,
        metadata,
        actions,
        data: { ...payload, ...data },
      });
    } catch (error) {
      this.report(error);
      return Promise.resolve(false);
    }
  }

  /** Flush queued events. Failed deliveries remain for retry. */
  flush(): Promise<number> {
    if (this.closed) return Promise.resolve(0);
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      this.expireQueue();
      let delivered = 0;
      let batchByteBudget = MAX_BATCH_BYTES;
      const remove = (entries: QueueEntry[]) => {
        const ids = new Set(entries.map((entry) => entry.event.id));
        let removed = 0;
        this.queue = this.queue.filter((entry) => {
          if (!ids.has(entry.event.id)) return true;
          this.queueBytes -= entry.bytes;
          ++removed;
          return false;
        });
        return removed;
      };
      while (!this.closed && this.queue.length) {
        this.expireQueue();
        const batch: QueueEntry[] = [];
        let batchBytes = 2; // JSON array brackets
        for (const entry of this.queue) {
          const nextBytes = batchBytes + entry.bytes + (batch.length ? 1 : 0);
          if (batch.length && (batch.length >= 100 || nextBytes > batchByteBudget)) break;
          batch.push(entry);
          batchBytes = nextBytes;
        }
        if (!batch.length) break;
        let response: { events: StoredEvent[] } | undefined;
        let status: unknown;
        try {
          response = await this.transport.request(
            'POST',
            '/events',
            batch.map((entry) => entry.event),
          );
        } catch (error) {
          this.report(error);
          if (error && typeof error === 'object' && 'status' in error) status = error.status;
        }
        if (!response) {
          if (status === 413) {
            // A custom endpoint may impose a smaller cap. Split safely because event IDs are idempotent.
            if (batch.length > 1) {
              batchByteBudget = Math.max(1, Math.floor(batchBytes / 2));
              continue;
            }
            this.dropped += remove(batch);
            this.report(
              new Error('Dropped an event rejected by the endpoint as too large (HTTP 413)'),
            );
            continue;
          }
          this.retry();
          break;
        }
        remove(batch);
        delivered += batch.length;
      }
      return delivered;
    })()
      .catch((error) => {
        this.report(error);
        return 0;
      })
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  subscribe(pattern: string, handler: (event: StoredEvent) => unknown): () => void {
    if (this.closed) return () => {};
    const subscription = { pattern, handler };
    this.subscriptions.add(subscription);
    this.updateSubscriptions();
    return () => {
      this.subscriptions.delete(subscription);
      this.updateSubscriptions();
    };
  }

  private updateSubscriptions(): void {
    if (this.closed) return;
    this.registration.subscriptions = [...new Set([...this.subscriptions].map((s) => s.pattern))];
    this.disconnect();
    // Finish any registration already in progress before opening the updated stream.
    void Promise.resolve(this.connecting)
      .then(() => this.connect())
      .catch((error) => this.report(error));
  }

  async query(query: EventQuery = {}): Promise<QueryResult> {
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) params.set(key, String(value));
      return (await this.call<QueryResult>('GET', `/events?${params}`)) ?? { events: [], total: 0 };
    } catch (error) {
      this.report(error);
      return { events: [], total: 0 };
    }
  }

  async registerCapability(
    capability: string | CapabilityInput,
    handler?: CommandHandler,
  ): Promise<boolean> {
    try {
      const parsed = capabilitySchema.parse(
        typeof capability === 'string' ? { name: capability } : capability,
      );
      this.registration.capabilities = [
        ...this.registration.capabilities.filter((item) => item.name !== parsed.name),
        parsed,
      ];
      if (handler) this.handlers.set(parsed.name, handler);
      return await this.register();
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  async registerAction(action: ActionInput): Promise<boolean> {
    try {
      const parsed = actionSchema.parse(redact(action));
      this.registration.actions = [
        ...this.registration.actions.filter((item) => item.id !== parsed.id),
        parsed,
      ];
      return await this.register();
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  async heartbeat(health: ApplicationRegistration['health'] = 'healthy'): Promise<boolean> {
    this.registration.health = health;
    const response = await this.call(
      'POST',
      `/applications/${encodeURIComponent(this.registration.id)}/heartbeat`,
      { health },
    );
    if (!response) {
      const registered = await this.register();
      void this.connect();
      return registered;
    }
    if (!this.connection) void this.connect();
    return true;
  }

  async identifyProject(project: ProjectInput): Promise<ProjectRecord | undefined> {
    try {
      const parsed = projectSchema.parse(redact(project));
      this.projects.set(parsed.id, parsed);
      return (await this.call<{ project: ProjectRecord }>('POST', '/projects', parsed))?.project;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  /** Submit without waiting. Commands are never buffered or retried automatically. */
  async command(input: CommandInput): Promise<CommandRecord | undefined> {
    try {
      return (await this.call<{ command: CommandRecord }>('POST', '/commands', redact(input)))
        ?.command;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  async getCommand(id: string): Promise<CommandRecord | undefined> {
    return (
      await this.call<{ command: CommandRecord }>('GET', `/commands/${encodeURIComponent(id)}`)
    )?.command;
  }

  /** Route a capability and poll its acknowledgement/result until terminal or unavailable. */
  async request(
    input: CommandInput | string,
    payload?: Record<string, unknown>,
  ): Promise<CommandRecord | undefined> {
    try {
      let command = await this.command(
        typeof input === 'string' ? { command: input, payload } : input,
      );
      while (
        command &&
        !this.closed &&
        (command.status === 'pending' || command.status === 'accepted')
      ) {
        if (Date.parse(command.expiresAt) <= Date.now()) return { ...command, status: 'timeout' };
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 150);
        });
        command = await this.getCommand(command.id);
      }
      return command;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  execute(input: CommandInput): Promise<CommandRecord | undefined> {
    return this.request(input);
  }

  /** Each line becomes an idempotent, redacted event and uses the same offline queue. */
  async ingestLogs(
    lines: string | string[],
    options: {
      stream?: 'stdout' | 'stderr' | 'file';
      project?: ProjectIdentity;
      correlationId?: string;
    } = {},
  ): Promise<number> {
    try {
      let accepted = 0;
      for (const line of Array.isArray(lines) ? lines : lines.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let parsed: Record<string, unknown> = {};
        let structuredJson: unknown;
        try {
          const value: unknown = JSON.parse(line);
          if (value && typeof value === 'object') {
            structuredJson = value;
            parsed = Array.isArray(value) ? { entries: value } : (value as Record<string, unknown>);
          }
        } catch {
          /* plain text log */
        }
        const severity = ['debug', 'info', 'success', 'warning', 'error', 'critical'].includes(
          String(parsed.level ?? parsed.severity),
        )
          ? ((parsed.level ?? parsed.severity) as RippleyEvent['severity'])
          : options.stream === 'stderr'
            ? 'error'
            : 'info';
        const message =
          typeof parsed.message === 'string'
            ? parsed.message
            : typeof parsed.msg === 'string'
              ? parsed.msg
              : structuredJson
                ? JSON.stringify(redact(structuredJson))
                : line;
        if (
          await this.publish({
            type: `log.${options.stream ?? 'stdout'}`,
            message,
            severity,
            project: options.project,
            correlationId: options.correlationId,
            data: parsed,
            metadata: { stream: options.stream ?? 'stdout' },
          })
        )
          ++accepted;
      }
      return accepted;
    } catch (error) {
      this.report(error);
      return 0;
    }
  }

  /** Stop background work immediately. Call flush() before close() to attempt delivery. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.disconnect();
    this.queue = [];
    this.queueBytes = 0;
    try {
      this.transport.close?.();
    } catch (error) {
      this.report(error);
    }
  }
}
export function createBlackBoxClient(options: ClientOptions): BlackBoxClient {
  return new BlackBoxClient(options);
}
export const createClient = createBlackBoxClient;
