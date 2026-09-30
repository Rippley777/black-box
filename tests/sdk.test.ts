import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createBlackBoxClient,
  type BlackBoxTransport,
  type StreamCallbacks,
  type StreamOptions,
  type CommandRecord,
  type StoredEvent,
} from '../packages/sdk/src/index.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class MemoryTransport implements BlackBoxTransport {
  online = true;
  calls: { method: string; path: string; body?: unknown }[] = [];
  streams: { options: StreamOptions; callbacks: StreamCallbacks }[] = [];
  delivered: StoredEvent[] = [];
  maxBodyBytes = 2 * 1024 * 1024;
  oversizedRequests = 0;
  commands = new Map<string, CommandRecord>();
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    this.calls.push({
      method,
      path,
      body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
    });
    if (!this.online) throw new Error('Daemon unavailable');
    if (path === '/events') {
      if (Buffer.byteLength(JSON.stringify(body)) > this.maxBodyBytes) {
        ++this.oversizedRequests;
        throw Object.assign(new Error('Request body too large'), { status: 413 });
      }
      const events = (body as StoredEvent[]).map((event) => ({
        ...event,
        sequence: this.delivered.length + 1,
      }));
      this.delivered.push(...events);
      return { events } as T;
    }
    if (path.startsWith('/events?'))
      return { events: this.delivered, total: this.delivered.length } as T;
    if (path.endsWith('/ack')) {
      const id = path.split('/')[2];
      const command = { ...this.commands.get(id), ...(body as object) } as CommandRecord;
      this.commands.set(id, command);
      return { command } as T;
    }
    if (path.startsWith('/commands/'))
      return { command: this.commands.get(path.split('/')[2]) } as T;
    return { application: body, project: body } as T;
  }
  connect(options: StreamOptions, callbacks: StreamCallbacks) {
    this.streams.push({ options, callbacks });
    queueMicrotask(callbacks.open);
    return { close() {} };
  }
}
const clientFor = (
  transport: MemoryTransport,
  extra: Parameters<typeof createBlackBoxClient>[0] = { app: 'test-app' },
) => createBlackBoxClient({ transport, heartbeatMs: 0, reconnectMinMs: 100_000, ...extra });
function event(sequence: number): StoredEvent {
  return {
    id: randomUUID(),
    schemaVersion: '1.0',
    timestamp: new Date().toISOString(),
    source: { app: 'other' },
    type: 'process.started',
    message: 'Process started',
    severity: 'info',
    data: {},
    tags: [],
    metadata: {},
    actions: [],
    sequence,
  };
}

test('offline event queue fails open, redacts before buffering, evicts oldest, and recovers', async () => {
  const transport = new MemoryTransport();
  transport.online = false;
  const client = clientFor(transport, {
    app: 'test-app',
    queueLimit: 2,
    onError() {
      throw new Error('Observer failure');
    },
  });
  try {
    assert.equal(await client.emit('process.started', { message: 'oldest' }), true);
    assert.equal(
      await client.emit('process.started', {
        message: 'Bearer abc1234',
        apiKey: 'never-keep-this',
        nested: { password: 'also-secret' },
      }),
      true,
    );
    assert.equal(
      await client.emit('process.stopped', {
        message: 'DATABASE_URL=postgres://user:pass@localhost/db',
      }),
      true,
    );
    await client.flush();
    assert.equal(client.stats.queued, 2);
    assert.equal(client.stats.dropped, 1);
    const recorded = JSON.stringify(transport.calls);
    assert.ok(!recorded.includes('never-keep-this'));
    assert.ok(!recorded.includes('also-secret'));
    assert.ok(!recorded.includes('user:pass'));
    transport.online = true;
    await client.flush();
    assert.equal(client.stats.queued, 0);
    assert.equal(transport.delivered.length, 2);
    assert.equal(transport.delivered[0].data.apiKey, '[REDACTED]');
    assert.ok(transport.delivered[0].message.includes('[REDACTED]'));
  } finally {
    client.close();
  }
});

test('offline queue respects byte budget and TTL; invalid events never reject the host', async () => {
  const transport = new MemoryTransport();
  transport.online = false;
  const client = clientFor(transport, { app: 'test-app', queueMaxBytes: 600, queueTtlMs: 10 });
  try {
    assert.equal(await client.emit('invalid-event-type'), false);
    assert.equal(await client.emit('log.stdout', { message: 'x'.repeat(1_000) }), false);
    assert.equal(await client.emit('log.stdout', { message: 'temporary' }), true);
    assert.equal(client.stats.queued, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.stats.queued, 0);
    assert.equal(client.stats.dropped, 2);
    assert.ok((await client.query()).events.length === 0);
    client.close();
    assert.equal(await client.emit('application.started'), false);
  } finally {
    client.close();
  }
});

test('zero queue budget sends online without buffering, and burst flush drains additions', async () => {
  const directTransport = new MemoryTransport();
  const direct = clientFor(directTransport, { app: 'direct', queueLimit: 0 });
  try {
    assert.equal(await direct.emit('application.started'), true);
    assert.equal(directTransport.delivered.length, 1);
    directTransport.online = false;
    assert.equal(await direct.emit('application.started'), false);
    assert.equal(direct.stats.queued, 0);
  } finally {
    direct.close();
  }
  const transport = new MemoryTransport();
  const client = clientFor(transport);
  try {
    await Promise.all(
      Array.from({ length: 180 }, (_, index) =>
        client.emit('log.stdout', { message: `Line ${index}` }),
      ),
    );
    await client.flush();
    assert.equal(transport.delivered.length, 180);
    assert.equal(client.stats.queued, 0);
  } finally {
    client.close();
  }
});

test('subscription callbacks are isolated, replay is deduplicated, cursor resumes after actual events', async () => {
  const transport = new MemoryTransport();
  const errors: string[] = [];
  const client = clientFor(transport, {
    app: 'test-app',
    reconnectMinMs: 10,
    reconnectMaxMs: 10,
    onError: (error) => errors.push(error.message),
  });
  let received = 0;
  try {
    client.subscribe('process.*', async () => {
      throw new Error('Consumer failed');
    });
    const unsubscribe = client.subscribe('process.*', () => {
      received++;
    });
    await tick();
    await tick();
    const stream = transport.streams.at(-1)!;
    assert.deepEqual(stream.options.patterns, ['process.*']);
    stream.callbacks.message({ kind: 'ready', latestSequence: 900 });
    const observed = event(8);
    stream.callbacks.message({ kind: 'event', event: observed, replay: true });
    stream.callbacks.message({ kind: 'event', event: observed });
    stream.callbacks.message({ kind: 'event', event: { ...event(9), type: 'deploy.started' } });
    await tick();
    assert.equal(received, 1);
    assert.ok(errors.includes('Consumer failed'));
    stream.callbacks.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(transport.streams.at(-1)!.options.since, 9);
    assert.ok(transport.calls.filter((call) => call.path === '/applications').length >= 2);
    unsubscribe();
  } finally {
    client.close();
  }
});

test('provider execution requires acceptance, ignores duplicate/replayed commands, and acknowledges errors', async () => {
  const transport = new MemoryTransport();
  const client = clientFor(transport);
  let executions = 0;
  try {
    await client.registerCapability('project.validate', () => {
      executions++;
      throw new Error('password=oops validation failed');
    });
    await tick();
    await tick();
    const command: CommandRecord = {
      id: randomUUID(),
      provider: 'test-app',
      command: 'project.validate',
      payload: {},
      correlationId: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    };
    transport.commands.set(command.id, command);
    const stream = transport.streams.at(-1)!;
    stream.callbacks.message({ kind: 'command', command });
    stream.callbacks.message({ kind: 'command', command });
    await tick();
    await tick();
    assert.equal(executions, 1);
    const acks = transport.calls.filter((call) => call.path.endsWith('/ack'));
    assert.deepEqual(
      acks.map((call) => (call.body as { status: string }).status),
      ['accepted', 'failed'],
    );
    assert.ok(!JSON.stringify(acks).includes('oops'));
    const replay = { ...command, id: randomUUID() };
    stream.callbacks.message({ kind: 'command', command: replay, replay: true } as Parameters<
      StreamCallbacks['message']
    >[0]);
    stream.callbacks.message({
      kind: 'command',
      command: { ...command, id: randomUUID(), provider: 'somebody-else' },
    });
    await tick();
    assert.equal(executions, 1);
    transport.online = false;
    stream.callbacks.message({ kind: 'command', command: { ...command, id: randomUUID() } });
    await tick();
    assert.equal(executions, 1);
  } finally {
    client.close();
  }
});

test('log ingestion normalizes JSON and plain text without retaining secrets', async () => {
  const transport = new MemoryTransport();
  const client = clientFor(transport);
  try {
    assert.equal(
      await client.ingestLogs(
        [
          '{"level":"warning","msg":"Check config","password":"hidden"}',
          'Authorization: Bearer abc123',
        ],
        { stream: 'stderr' },
      ),
      2,
    );
    await client.flush();
    assert.equal(transport.delivered[0].severity, 'warning');
    assert.equal(transport.delivered[0].data.password, '[REDACTED]');
    assert.equal(transport.delivered[1].severity, 'error');
    assert.ok(!JSON.stringify(transport.delivered).includes('abc123'));
    await client.ingestLogs([
      '{"password":123456789,"nested":{"token":{"value":"nested-private-value"}}}',
      '[{"password":987654321}]',
    ]);
    await client.flush();
    const serialized = JSON.stringify(transport.delivered);
    assert.ok(!serialized.includes('123456789'));
    assert.ok(!serialized.includes('nested-private-value'));
    assert.ok(!serialized.includes('987654321'));
    assert.equal(transport.delivered[2].data.password, '[REDACTED]');
  } finally {
    client.close();
  }
});

test('background offline retries and heartbeat do not keep a Node host alive', async () => {
  const source = `import { createBlackBoxClient } from './packages/sdk/src/index.ts';
createBlackBoxClient({ app:'exit-test', transport:{request:async()=>{throw new Error('offline')},connect:()=>({close(){}})},reconnectMinMs:20,heartbeatMs:100 });`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    { cwd: process.cwd(), timeout: 3_000 },
  );
  assert.equal(result.stderr, '');
});

test('large offline queues drain in byte-bounded batches below the daemon body limit', async () => {
  const transport = new MemoryTransport();
  transport.online = false;
  const client = clientFor(transport, { app: 'large-queue', queueMaxBytes: 4 * 1024 * 1024 });
  try {
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        client.emit('log.stdout', { message: 'line '.repeat(12_000), data: { index } }),
      ),
    );
    await client.flush();
    assert.equal(client.stats.queued, 40);
    transport.online = true;
    assert.equal(await client.flush(), 40);
    assert.equal(transport.oversizedRequests, 0);
    assert.equal(client.stats.queued, 0);
    assert.equal(transport.delivered.length, 40);
    assert.deepEqual(
      transport.delivered.map((event) => event.data.index),
      Array.from({ length: 40 }, (_, index) => index),
    );
  } finally {
    client.close();
  }
});

test('oversized events and single-event HTTP 413 responses cannot poison the queue', async () => {
  const transport = new MemoryTransport();
  transport.online = false;
  const errors: string[] = [];
  const client = clientFor(transport, {
    app: 'small-endpoint',
    queueMaxBytes: 4 * 1024 * 1024,
    onError: (error) => errors.push(error.message),
  });
  try {
    assert.equal(
      await client.emit('log.stdout', { data: { content: 'line '.repeat(220_000) } }),
      false,
    );
    assert.equal(client.stats.dropped, 1);
    assert.ok(errors.some((message) => /1 MiB/.test(message)));
    transport.maxBodyBytes = 1_000;
    await client.emit('log.stdout', { message: 'too large '.repeat(200) });
    await client.emit('log.stdout', { message: 'valid subsequent event' });
    await client.flush();
    transport.online = true;
    assert.equal(await client.flush(), 1);
    assert.equal(client.stats.queued, 0);
    assert.equal(client.stats.dropped, 2);
    assert.match(client.stats.lastError!, /413/);
    assert.equal(transport.delivered[0].message, 'valid subsequent event');
  } finally {
    client.close();
  }
});
