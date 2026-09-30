import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../apps/daemon/src/index.js';
import { createBlackBoxClient } from '../packages/sdk/src/index.js';
import type { StoredEvent } from '../packages/protocol/src/index.js';

async function eventually(check: () => boolean | Promise<boolean>, label: string, timeout = 4000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`Timed out: ${label}`);
}

test('SDK connects real independent apps, correlates a project and routes acknowledged commands', async () => {
  const daemon = createDaemon({ databasePath: ':memory:', port: 0 });
  const endpoint = await daemon.listen();
  const source = createBlackBoxClient({
    app: 'pit-boss',
    endpoint,
    heartbeatMs: 200,
    reconnectMinMs: 20,
  });
  const observer = createBlackBoxClient({
    app: 'port-authority',
    endpoint,
    heartbeatMs: 200,
    reconnectMinMs: 20,
  });
  const received: StoredEvent[] = [];
  const unsubscribe = observer.subscribe('process.*', (event) => received.push(event));
  try {
    await source.identifyProject({
      id: 'integration-project',
      name: 'Integration Project',
      paths: ['/test/integration-project'],
      repo: 'Rippley777/integration-project',
    });
    await source.registerCapability(
      { name: 'project.inspect', requiresConfirmation: false },
      (payload) => ({ projectId: payload.projectId, running: true, apiKey: 'must-not-return' }),
    );
    await eventually(
      () => source.stats.connected && observer.stats.connected,
      'connected SDK streams',
    );
    await source.emit('command.started', {
      project: { id: 'integration-project' },
      correlationId: 'session-one',
      message: 'Development command started',
      data: { command: 'npm run dev' },
    });
    await source.emit('process.started', {
      project: { path: '/test/integration-project' },
      correlationId: 'session-one',
      message: 'Node process listening',
      data: { pid: 731, port: 5173, password: 'must-not-store' },
    });
    await source.flush();
    await eventually(
      () => received.some((e) => e.type === 'process.started'),
      'filtered WebSocket delivery',
    );
    assert.equal(received.length, 1);
    assert.equal(received[0].project?.id, 'integration-project');
    assert.equal(received[0].data.password, '[REDACTED]');
    const query = await observer.query({ q: 'project:integration-project port:5173' });
    assert.equal(query.events.length, 1);
    const context = await fetch(`${endpoint}/events/${received[0].id}/context`).then((r) =>
      r.json(),
    );
    assert.equal(context.events.length, 2);
    const command = await observer.request({
      provider: 'pit-boss',
      command: 'project.inspect',
      payload: { projectId: 'integration-project' },
      timeoutMs: 2000,
    });
    assert.equal(command?.status, 'completed');
    assert.deepEqual(command?.result, {
      projectId: 'integration-project',
      running: true,
      apiKey: '[REDACTED]',
    });
    const lifecycle = await observer.query({ correlationId: command!.correlationId });
    assert.deepEqual(
      new Set(lifecycle.events.map((e) => e.type)),
      new Set(['command.pending', 'command.accepted', 'command.completed']),
    );
  } finally {
    unsubscribe();
    source.close();
    observer.close();
    await daemon.close();
  }
});

test('outage buffering survives a recorder restart and re-registers providers without duplicating events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'black-box-restart-'));
  const databasePath = join(directory, 'events.db');
  let daemon = createDaemon({ databasePath, port: 0 });
  const endpoint = await daemon.listen();
  const port = Number(new URL(endpoint).port);
  const client = createBlackBoxClient({
    app: 'reconnecting-app',
    endpoint,
    heartbeatMs: 100,
    reconnectMinMs: 20,
    reconnectMaxMs: 50,
    requestTimeoutMs: 200,
  });
  try {
    await client.registerCapability('application.inspect', () => ({ available: true }));
    await eventually(() => client.stats.connected, 'initial connection');
    await client.emit('application.started', { message: 'Before restart' });
    await eventually(async () => (await client.query()).total === 1, 'initial persisted event');
    await daemon.close();
    await eventually(() => !client.stats.connected, 'disconnect detection');
    await client.emit('application.warning', {
      message: 'During outage',
      severity: 'warning',
      data: { token: 'must-not-buffer' },
    });
    assert.equal(client.stats.queued, 1);
    daemon = createDaemon({ databasePath, port });
    await daemon.listen();
    await eventually(
      () => client.stats.connected && client.stats.queued === 0,
      'reconnect and queue drain',
    );
    const history = await client.query();
    assert.equal(history.total, 2);
    assert.equal(
      history.events.find((e) => e.message === 'During outage')?.data.token,
      '[REDACTED]',
    );
    const command = await client.request({
      provider: 'reconnecting-app',
      command: 'application.inspect',
      timeoutMs: 1500,
    });
    assert.equal(command?.status, 'completed');
  } finally {
    client.close();
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('short bursts flush promptly without waiting for a heartbeat', async () => {
  const daemon = createDaemon({ databasePath: ':memory:', port: 0 });
  const endpoint = await daemon.listen();
  const client = createBlackBoxClient({ app: 'burst-app', endpoint, heartbeatMs: 60000 });
  try {
    await eventually(() => client.stats.connected, 'burst provider connected');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        client.emit('build.progress', { message: `Build ${i}` }),
      ),
    );
    await eventually(
      () => daemon.store.count() === 20,
      'all burst events persisted promptly',
      1500,
    );
    assert.equal(client.stats.queued, 0);
  } finally {
    client.close();
    await daemon.close();
  }
});

test('failure reconstruction surfaces missing configuration before an HTTP error and process exit', async () => {
  const daemon = createDaemon({ databasePath: ':memory:', port: 0 });
  try {
    const now = Date.now();
    const events = daemon.store.ingest(
      [
        {
          type: 'environment.missing_variable',
          source: { app: 'env-reaper' },
          message: 'Missing API_URL',
          severity: 'warning',
        },
        {
          type: 'http.error',
          source: { app: 'save-scum' },
          message: 'HTTP 500',
          severity: 'error',
        },
        {
          type: 'process.exited',
          source: { app: 'port-authority' },
          message: 'Node exited with status 1',
          severity: 'error',
        },
      ].map((e, index) => ({
        ...e,
        id: randomUUID(),
        timestamp: new Date(now + index * 1000).toISOString(),
        project: { id: 'save-scum' },
        correlationId: 'failure-test',
      })),
    ).events;
    const context = daemon.store.context(events[2].id);
    assert.match(context.summary, /Missing API_URL is a likely contributor/);
    assert.match(context.summary, /HTTP 500 occurred 1 second/);
    assert.match(context.summary, /not a proven root cause/);
  } finally {
    await daemon.close();
  }
});
