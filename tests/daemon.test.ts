import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { createDaemon, Store } from '../apps/daemon/src/index.js';
import type { CommandRecord, RippleyEvent, StreamMessage } from '@rippley/blackbox-protocol';

const event = (values: Partial<RippleyEvent> = {}) => ({
  schemaVersion: '1.0',
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  source: { app: 'test-sensor' },
  type: 'process.started',
  severity: 'info',
  message: 'Development server started',
  data: {},
  tags: [],
  metadata: {},
  actions: [],
  ...values,
});

test('a newer database schema is rejected without silently downgrading it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'black-box-schema-'));
  const path = join(folder, 'future.db');
  try {
    const database = new Database(path);
    database.pragma('user_version = 2');
    database.close();
    assert.throws(() => new Store(path), /requires a newer version/);
    const preserved = new Database(path, { readonly: true });
    assert.equal(preserved.pragma('user_version', { simple: true }), 2);
    preserved.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('public mode requires a key and acknowledges writes only after a storage checkpoint', async (t) => {
  const token = 'a'.repeat(48);
  let saved: Buffer | undefined;
  const store = new Store(':memory:');
  const daemon = createDaemon({
    store,
    port: 0,
    publicOrigin: 'https://blackbox.example',
    accessToken: token,
    persist: async () => { saved = store.db.serialize(); },
  });
  await daemon.listen();
  t.after(() => daemon.close());
  const unauthorized = await fetch(`${daemon.url.replace('https://blackbox.example', 'http://127.0.0.1:' + (daemon.server.address() as { port: number }).port)}/api/events`);
  assert.equal(unauthorized.status, 401);
  const local = `http://127.0.0.1:${(daemon.server.address() as { port: number }).port}`;
  const response = await fetch(`${local}/api/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(event()),
  });
  assert.equal(response.status, 201);
  assert.ok(saved);
  const restored = new Store(saved);
  assert.equal(restored.count(), 1);
  restored.db.close();
  const login = await fetch(`${local}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
    body: new URLSearchParams({ token }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly; Secure; SameSite=Lax/);
  const hostileApi = await fetch(`${local}/api/health`, { headers: { origin: 'null', authorization: `Bearer ${token}` } });
  assert.equal(hostileApi.status, 403);
});
async function fixture(t: TestContext) {
  const daemon = createDaemon({ databasePath: ':memory:', port: 0, commandSweepMs: 20 });
  await daemon.listen();
  t.after(() => daemon.close());
  const call = async (path: string, method = 'GET', value?: unknown) => {
    const response = await fetch(daemon.url + path, {
      method,
      headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const data = await response.json();
    return { status: response.status, data };
  };
  return { daemon, call };
}
async function stream(t: TestContext, url: string) {
  const socket = new WebSocket(url.replace(/^http/, 'ws'));
  const messages: StreamMessage[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, messages };
}
async function until(check: () => boolean, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('SQLite persists redacted events, deduplicates IDs, and rolls back invalid batches', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-db-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'black-box.db');
  let daemon = createDaemon({ databasePath: path, port: 0 });
  const published = event({
    message: 'PASSWORD=super-secret-text',
    data: { password: 'super-secret-field', nested: { authorization: 'Bearer raw-secret' } },
    timestamp: '2026-09-30T15:30:00-05:00',
  });
  const first = daemon.store.ingest(published).events[0];
  assert.equal(first.timestamp, '2026-09-30T20:30:00.000Z');
  assert.equal(first.data.password, '[REDACTED]');
  assert.match(first.message, /\[REDACTED\]/);
  assert.equal(daemon.store.ingest(published).fresh.length, 0);
  assert.throws(() => daemon.store.ingest([event(), { ...event(), id: 'invalid' }]));
  assert.equal(daemon.store.count(), 1);
  await daemon.close();
  assert.doesNotMatch(await readFile(path, 'utf8'), /super-secret|raw-secret/);
  daemon = createDaemon({ databasePath: path, port: 0 });
  assert.equal(daemon.store.event(published.id)?.sequence, first.sequence);
  await daemon.close();
});

test('HTTP ingestion supports search, canonical project aliases, merged registration, and explicit conflicts', async (t) => {
  const { call } = await fixture(t);
  assert.equal(
    (
      await call('/projects', 'POST', {
        id: 'save-scum',
        name: 'Save Scum',
        paths: ['/Code/save-scum'],
        repo: 'Rippley777/save-scum',
        applications: ['pit-boss'],
      })
    ).status,
    201,
  );
  await call('/projects', 'POST', {
    id: 'save-scum',
    name: 'Save Scum',
    aliases: ['scum-dev'],
    applications: ['env-reaper'],
  });
  const p = (await call('/projects/save-scum')).data.project;
  assert.deepEqual(p.paths, ['/Code/save-scum']);
  assert.equal(p.repo, 'Rippley777/save-scum');
  assert.deepEqual(p.applications, ['pit-boss', 'env-reaper']);
  const e = event({
    source: { app: 'pit-boss' },
    project: { repo: 'git@github.com:Rippley777/save-scum.git' },
    type: 'deploy.failed',
    severity: 'error',
    data: { port: 5173, pid: 22141, command: 'npm run deploy' },
    tags: ['production'],
    message: 'Deployment failed after build',
  });
  const published = await call('/api/events', 'POST', e);
  assert.equal(published.status, 201);
  assert.equal(published.data.events[0].project.id, 'save-scum');
  for (const q of [
    'project:save-scum severity:error',
    'source:pit-boss type:deploy.*',
    'port:5173',
    'repo:Rippley777/save-scum',
    'tag:production "after build"',
    'project:scum-dev command:"npm run deploy"',
  ])
    assert.equal((await call(`/events?q=${encodeURIComponent(q)}`)).data.total, 1, q);
  assert.equal((await call('/events?q=port:9999')).data.total, 0);
  assert.equal(
    (
      await call('/projects', 'POST', {
        id: 'unrelated',
        name: 'Other repo',
        paths: ['/Code/save-scum'],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call('/projects', 'POST', {
        id: 'other',
        name: 'Other project',
        paths: ['/Elsewhere/save-scum'],
      })
    ).status,
    201,
  );
  assert.equal(
    (await call('/events', 'POST', event({ project: { id: 'other', path: '/Code/save-scum' } })))
      .status,
    409,
  );
  assert.equal(
    (
      await call('/projects', 'POST', {
        id: 'case-sensitive',
        name: 'Case sensitive path',
        paths: ['/Code/Save-Scum'],
      })
    ).status,
    201,
  );
});

test('WebSocket delivers matching live events and ascending replay without duplicate publish', async (t) => {
  const { daemon, call } = await fixture(t);
  const ignored = event({ type: 'repo.scan.completed' });
  const one = event(),
    two = event({ type: 'process.stopped' });
  await call('/events', 'POST', [ignored, one]);
  const live = await stream(t, `${daemon.url}/stream?patterns=process.*&since=0`);
  await until(() => live.messages.some((m) => m.kind === 'event'));
  const ready = live.messages.find((m) => m.kind === 'ready');
  assert.equal(ready?.kind === 'ready' && ready.latestSequence, 2);
  assert.equal(live.messages.filter((m) => m.kind === 'event').length, 1);
  const replay = live.messages.find((m) => m.kind === 'event');
  assert.equal(replay?.kind === 'event' && replay.event.id, one.id);
  assert.equal(replay?.kind === 'event' && replay.replay, true);
  await call('/events', 'POST', two);
  await until(() => live.messages.filter((m) => m.kind === 'event').length === 2);
  await call('/events', 'POST', two);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(live.messages.filter((m) => m.kind === 'event').length, 2);
  const resumed = await stream(t, `${daemon.url}/stream?patterns=process.*&since=2`);
  await until(() => resumed.messages.some((m) => m.kind === 'event'));
  assert.deepEqual(
    resumed.messages.filter((m) => m.kind === 'event').map((m) => m.event.id),
    [two.id],
  );
});

test('timestamp timeline order paginates buffered out-of-order events without changing durable replay/export order', async (t) => {
  const { daemon, call } = await fixture(t);
  const base = Date.now();
  const newest = event({ timestamp: new Date(base).toISOString(), message: 'newest' });
  const oldest = event({
    timestamp: new Date(base - 10000).toISOString(),
    message: 'oldest buffered',
  });
  const middle = event({
    timestamp: new Date(base - 5000).toISOString(),
    message: 'middle buffered',
  });
  const tiedNewest = event({ timestamp: newest.timestamp, message: 'newest timestamp tie' });
  await call('/events', 'POST', [newest, oldest, middle, tiedNewest]);
  const ids = (data: { events: { id: string }[] }) => data.events.map((e) => e.id);
  assert.deepEqual(ids((await call('/events')).data), [
    tiedNewest.id,
    middle.id,
    oldest.id,
    newest.id,
  ]);
  const pageOne = (await call('/events?order=timestamp&limit=2')).data;
  assert.deepEqual(ids(pageOne), [tiedNewest.id, newest.id]);
  const pageTwo = (await call(`/events?order=timestamp&limit=2&before=${pageOne.nextCursor}`)).data;
  assert.deepEqual(ids(pageTwo), [middle.id, oldest.id]);
  assert.equal(pageTwo.nextCursor, undefined);
  const oneAtATime = (await call('/events?order=timestamp&limit=1')).data;
  assert.deepEqual(
    ids((await call(`/events?order=timestamp&limit=1&before=${oneAtATime.nextCursor}`)).data),
    [newest.id],
  );
  assert.deepEqual(ids((await call('/events?order=timestamp&after=3')).data), [
    tiedNewest.id,
    newest.id,
  ]);
  assert.equal((await call('/events?order=timestamp&before=9999')).status, 400);
  assert.equal((await call('/events?order=invalid')).status, 400);
  const exported = await fetch(`${daemon.url}/export?order=timestamp`);
  assert.deepEqual(
    (await exported.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).id),
    [newest.id, oldest.id, middle.id, tiedNewest.id],
  );
  assert.deepEqual(
    daemon.store.query({ order: 'timestamp', after: 0 }, true).events.map((e) => e.id),
    [newest.id, oldest.id, middle.id, tiedNewest.id],
  );
  daemon.store.db.prepare('DELETE FROM events WHERE sequence=?').run(pageOne.nextCursor);
  assert.equal((await call(`/events?order=timestamp&before=${pageOne.nextCursor}`)).status, 400);
});

test('command routing requires a live capable provider, explicit confirmation, correct ACK, and persists terminal state', async (t) => {
  const { daemon, call } = await fixture(t);
  await call('/applications', 'POST', {
    id: 'pit-boss',
    name: 'Pit Boss',
    capabilities: [{ name: 'project.restart', requiresConfirmation: true }],
  });
  assert.equal(
    (await call('/commands', 'POST', { command: 'project.restart', confirmed: true })).status,
    409,
  );
  const provider = await stream(t, `${daemon.url}/stream?appId=pit-boss&patterns=command.*`);
  assert.equal((await call('/commands', 'POST', { command: 'project.restart' })).status, 409);
  const created = await call('/commands', 'POST', {
    command: 'project.restart',
    confirmed: true,
    payload: { projectId: 'save-scum', apiKey: 'do-not-persist' },
  });
  assert.equal(created.status, 202);
  const command = created.data.command;
  await until(() => provider.messages.some((m) => m.kind === 'command'));
  const delivered = provider.messages.find((m) => m.kind === 'command');
  assert.equal(delivered?.kind === 'command' && delivered.command.payload.apiKey, '[REDACTED]');
  assert.equal(
    (await call(`/commands/${command.id}/ack`, 'POST', { appId: 'wrong', status: 'completed' }))
      .status,
    403,
  );
  assert.equal(
    (await call(`/commands/${command.id}/ack`, 'POST', { appId: 'pit-boss', status: 'accepted' }))
      .status,
    200,
  );
  assert.equal(
    (
      await call(`/commands/${command.id}/ack`, 'POST', {
        appId: 'pit-boss',
        status: 'completed',
        result: { password: 'never-save' },
      })
    ).status,
    200,
  );
  const completed = (await call(`/commands/${command.id}`)).data.command;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.password, '[REDACTED]');
  assert.equal(
    (await call(`/commands/${command.id}/ack`, 'POST', { appId: 'pit-boss', status: 'failed' }))
      .status,
    409,
  );
  const audit = (await call(`/events?correlationId=${command.correlationId}`)).data.events;
  assert.deepEqual(
    audit.map((e: RippleyEvent) => e.type),
    ['command.completed', 'command.accepted', 'command.pending'],
  );
  const replay = await stream(t, `${daemon.url}/stream?since=0`);
  await until(() => replay.messages.some((m) => m.kind === 'event'));
  assert.equal(
    replay.messages.some((m) => m.kind === 'command'),
    false,
  );
  const timeout = (
    await call('/commands', 'POST', {
      provider: 'pit-boss',
      command: 'project.restart',
      confirmed: true,
      timeoutMs: 50,
    })
  ).data.command;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await call(`/commands/${timeout.id}`)).data.command.status, 'timeout');
  assert.equal(
    (await call(`/commands/${timeout.id}/ack`, 'POST', { appId: 'pit-boss', status: 'completed' }))
      .status,
    409,
  );
});

test('ambiguous command providers or provider sessions never execute commands', async (t) => {
  const { daemon, call } = await fixture(t);
  for (const id of ['one', 'two']) {
    await call('/applications', 'POST', { id, name: id, capabilities: [{ name: 'repo.scan' }] });
    await stream(t, `${daemon.url}/stream?appId=${id}`);
  }
  assert.equal((await call('/commands', 'POST', { command: 'repo.scan' })).status, 409);
  assert.equal(
    (await call('/commands', 'POST', { provider: 'one', command: 'repo.scan' })).status,
    202,
  );
  await stream(t, `${daemon.url}/stream?appId=one`);
  assert.equal(
    (await call('/commands', 'POST', { provider: 'one', command: 'repo.scan' })).status,
    409,
  );
});

test('invalid command project context and audit write failures create neither a command nor an audit event', async (t) => {
  const { daemon, call } = await fixture(t);
  await call('/applications', 'POST', {
    id: 'provider',
    name: 'Provider',
    capabilities: [{ name: 'project.run' }],
  });
  const provider = await stream(t, `${daemon.url}/stream?appId=provider`);
  for (const projectId of ['', 'x'.repeat(201), 123, null, { id: 'project' }]) {
    const result = await call('/commands', 'POST', {
      provider: 'provider',
      command: 'project.run',
      payload: { projectId },
    });
    assert.equal(result.status, 400);
  }
  assert.equal(
    (daemon.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get() as { n: number }).n,
    0,
  );
  assert.equal(daemon.store.count(), 0);
  daemon.store.db.exec(
    "CREATE TEMP TRIGGER reject_command_audit BEFORE INSERT ON events WHEN NEW.type='command.pending' BEGIN SELECT RAISE(ABORT, 'audit storage failure'); END",
  );
  assert.equal(
    (
      await call('/commands', 'POST', {
        provider: 'provider',
        command: 'project.run',
        payload: { projectId: 'valid-project' },
      })
    ).status,
    500,
  );
  assert.equal(
    (daemon.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get() as { n: number }).n,
    0,
  );
  assert.equal(daemon.store.count(), 0);
  assert.equal(
    provider.messages.some((m) => m.kind === 'command' || m.kind === 'event'),
    false,
  );
  daemon.store.db.exec('DROP TRIGGER reject_command_audit');
  assert.equal(
    (
      await call('/commands', 'POST', {
        provider: 'provider',
        command: 'project.run',
        payload: { projectId: 'valid-project' },
      })
    ).status,
    202,
  );
});

test('startup and deadline sweeps recover historical commands with malformed project context', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-command-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'black-box.db');
  const oldStore = new Store(databasePath);
  const historical: CommandRecord = {
    id: randomUUID(),
    provider: 'old-provider',
    command: 'project.run',
    payload: { projectId: 'x'.repeat(201) },
    correlationId: randomUUID(),
    status: 'pending',
    createdAt: new Date(Date.now() - 10000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  oldStore.saveCommand(historical);
  oldStore.db.close();
  const daemon = createDaemon({ databasePath, port: 0, commandSweepMs: 10 });
  t.after(() => daemon.close());
  await daemon.listen();
  assert.equal(daemon.store.command(historical.id)?.status, 'timeout');
  const audit = daemon.store.query({ correlationId: historical.correlationId }).events;
  assert.equal(audit[0].type, 'command.timeout');
  assert.equal(audit[0].project, undefined);
  const later = {
    ...historical,
    id: randomUUID(),
    correlationId: randomUUID(),
    payload: { projectId: '' },
  };
  daemon.store.saveCommand(later);
  await until(() => daemon.store.command(later.id)?.status === 'timeout');
  assert.equal((await fetch(daemon.url + '/health')).status, 200);
  assert.equal(
    daemon.store.query({ correlationId: later.correlationId }).events[0].project,
    undefined,
  );
});

test('deterministic context groups evidence, distinguishes projects, and supports incident lifecycle', async (t) => {
  const { call } = await fixture(t);
  const base = Date.now();
  const before = event({
    project: { id: 'save-scum' },
    timestamp: new Date(base - 10000).toISOString(),
    source: { app: 'env-reaper' },
    type: 'environment.missing_variable',
    severity: 'warning',
    message: 'Missing API_URL',
  });
  const failure = event({
    project: { id: 'save-scum' },
    timestamp: new Date(base).toISOString(),
    type: 'process.exited',
    severity: 'error',
    data: { pid: 99, port: 5173 },
    message: 'Process exited with code 1',
  });
  const unrelated = event({
    project: { id: 'different-project' },
    timestamp: new Date(base).toISOString(),
    data: { pid: 99, port: 5173 },
  });
  await call('/events', 'POST', [before, failure, unrelated]);
  const context = (await call(`/events/${failure.id}/context`)).data;
  assert.deepEqual(
    context.events.map((e: RippleyEvent) => e.id),
    [before.id, failure.id],
  );
  assert.match(context.summary, /Missing API_URL/);
  assert.match(context.summary, /10 seconds earlier/);
  assert.match(context.summary, /hypothesis.*not a proven root cause/);
  assert.ok(context.reasons.some((r: string) => r.includes('Same project')));
  const incident = (
    await call('/incidents', 'POST', { eventId: failure.id, title: 'Save Scum stopped working' })
  ).data.incident;
  assert.equal(incident.status, 'open');
  assert.equal(incident.eventIds.length, 2);
  const resolved = (await call(`/incidents/${incident.id}`, 'PATCH', { status: 'resolved' })).data
    .incident;
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolvedAt);
  assert.equal((await call('/incidents')).data.incidents.length, 1);
});

test('text/JSON logs redact before persistence, export is NDJSON, retention preserves errors', async (t) => {
  const { daemon, call } = await fixture(t);
  const logs = await call('/logs', 'POST', {
    source: { app: 'pit-boss' },
    stream: 'stderr',
    lines: [
      'request Authorization: Bearer abc.def.ghi',
      JSON.stringify({ level: 'warn', msg: 'configuration missing', password: 'private-value' }),
      JSON.stringify({ password: 123456, apiKey: { value: 'nested-private-value' } }),
      JSON.stringify([{ password: 987654321 }]),
    ],
  });
  assert.equal(logs.status, 201);
  assert.equal(logs.data.events.length, 4);
  assert.doesNotMatch(
    JSON.stringify(logs.data),
    /abc\.def\.ghi|private-value|123456|nested-private-value|987654321/,
  );
  assert.equal(logs.data.events[1].severity, 'warning');
  const old = new Date(Date.now() - 100 * 86400000).toISOString();
  await call('/events', 'POST', [
    event({ timestamp: old, severity: 'info' }),
    event({ timestamp: old, severity: 'error', message: 'old error kept' }),
  ]);
  assert.equal((await call('/maintenance', 'POST', {})).data.deleted, 1);
  assert.equal((await call('/events?q=old')).data.total, 1);
  assert.equal((await call('/settings', 'PATCH', { retention: { constructor: 1 } })).status, 400);
  assert.equal((await call('/settings', 'PATCH', { retention: { error: 7 } })).status, 200);
  assert.equal((await call('/maintenance', 'POST', {})).data.deleted, 1);
  const exported = await fetch(`${daemon.url}/export?source=pit-boss`);
  assert.match(exported.headers.get('content-type')!, /ndjson/);
  const text = await exported.text();
  assert.doesNotMatch(text, /abc\.def\.ghi|private-value|123456|nested-private-value|987654321/);
  assert.equal(
    text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)).length,
    4,
  );
  const eco = (await call('/ecosystem')).data;
  assert.equal(eco.remoteSync, false);
  assert.equal('message' in eco.applications[0], false);
});

test('a clean environment scan clears only that provider warnings and restores project health', async (t) => {
  const { call } = await fixture(t);
  for (const app of ['env-reaper', 'another-sensor'])
    await call(
      '/events',
      'POST',
      event({
        source: { app },
        project: { id: 'project' },
        type: 'environment.missing_variable',
        severity: 'warning',
        data: { variable: 'API_URL' },
      }),
    );
  assert.equal((await call('/projects/project')).data.stats.environmentWarnings, 2);
  await call(
    '/events',
    'POST',
    event({
      source: { app: 'env-reaper' },
      project: { id: 'project' },
      type: 'environment.scan.completed',
      severity: 'success',
      data: { missing: 0, exposed: 0 },
    }),
  );
  assert.equal((await call('/projects/project')).data.stats.environmentWarnings, 1);
  await call(
    '/events',
    'POST',
    event({
      source: { app: 'another-sensor' },
      project: { id: 'project' },
      type: 'environment.scan.completed',
      severity: 'success',
      data: { missing: 0, exposed: 0 },
    }),
  );
  const stats = (await call('/projects/project')).data.stats;
  assert.equal(stats.environmentWarnings, 0);
  assert.equal(stats.status, 'healthy');
});

test('retention never resurrects registered process associations as live processes', async (t) => {
  const { daemon, call } = await fixture(t);
  await call('/projects', 'POST', { id: 'project', name: 'Project', processes: [42] });
  assert.equal((await call('/projects/project')).data.stats.runningProcesses, 0);
  await call(
    '/events',
    'POST',
    event({
      project: { id: 'project' },
      type: 'process.stopped',
      timestamp: new Date(Date.now() - 100 * 86400000).toISOString(),
      data: { pid: 42 },
    }),
  );
  assert.equal((await call('/projects/project')).data.stats.runningProcesses, 0);
  assert.equal(daemon.store.cleanup(), 1);
  assert.equal((await call('/projects/project')).data.stats.runningProcesses, 0);
  await call(
    '/events',
    'POST',
    event({ project: { id: 'project' }, type: 'process.started', data: { pid: 43 } }),
  );
  assert.equal((await call('/projects/project')).data.stats.runningProcesses, 1);
});

test('local transport rejects hostile origins/hosts, simple form writes, large bodies and secret-bearing validation errors', async (t) => {
  const { daemon, call } = await fixture(t);
  for (const headers of [
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { Origin: 'http://tauri.localhost.attacker.example' },
  ])
    assert.equal((await fetch(`${daemon.url}/health`, { headers })).status, 403);
  const hostileHost = await new Promise<number>((resolve, reject) => {
    const req = request(
      `${daemon.url}/health`,
      { headers: { Host: 'attacker.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostileHost, 403);
  assert.equal(
    (await fetch(`${daemon.url}/health`, { headers: { Origin: daemon.url } })).headers.get(
      'access-control-allow-origin',
    ),
    daemon.url,
  );
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'])
    assert.equal(
      (await fetch(`${daemon.url}/health`, { headers: { Origin: origin } })).headers.get(
        'access-control-allow-origin',
      ),
      origin,
    );
  assert.equal(
    (await fetch(`${daemon.url}/events`, { method: 'POST', body: JSON.stringify(event()) })).status,
    415,
  );
  assert.equal(
    (
      await fetch(`${daemon.url}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: 'a'.repeat(2 * 1024 * 1024) }),
      })
    ).status,
    413,
  );
  const invalid = await call('/events', 'POST', { ...event(), severity: 'secret-must-not-echo' });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(JSON.stringify(invalid.data), /secret-must-not-echo/);
  const ws = new WebSocket(daemon.url.replace(/^http/, 'ws') + '/stream', {
    origin: 'https://attacker.example',
  });
  const status = await new Promise<number>((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode!);
      ws.terminate();
    });
    ws.on('error', () => {});
    ws.on('open', () => reject(new Error('Hostile socket should not open')));
  });
  assert.equal(status, 403);
});
