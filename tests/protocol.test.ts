import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  eventSchema,
  matchesPattern,
  normalizeIdentity,
  redact,
  redactText,
} from '../packages/protocol/src/index.js';

test('protocol v1 validates required envelope and rejects unknown versions', () => {
  const input = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: { app: 'port-authority' },
    type: 'port.opened',
    message: 'Port opened',
  };
  const event = eventSchema.parse(input);
  assert.equal(event.schemaVersion, '1.0');
  assert.deepEqual(event.tags, []);
  assert.deepEqual(event.metadata, {});
  assert.equal(eventSchema.safeParse({ ...input, schemaVersion: '2.0' }).success, false);
  assert.equal(eventSchema.safeParse({ ...input, type: 'bad type' }).success, false);
  assert.equal(eventSchema.safeParse({ ...input, timestamp: 'not-a-date' }).success, false);
  assert.equal(eventSchema.safeParse({ ...input, project: {} }).success, false);
});

test('patterns match namespaces and escape regex metacharacters', () => {
  assert.ok(matchesPattern('process.started', 'process.*'));
  assert.ok(matchesPattern('repo.scan.completed', 'repo.*'));
  assert.ok(matchesPattern('process.started', '*'));
  assert.ok(!matchesPattern('process.started', 'deploy.*'));
  assert.ok(!matchesPattern('processXstarted', 'process.started'));
  assert.ok(!matchesPattern('abc', '(.*)'));
});

test('redacts nested secrets, credentials, bearer tokens and private keys without mutation', () => {
  const input = {
    password: 'correct-horse',
    child: [{ api_key: 'abcd', good: 5173 }],
    authorization: 'Basic abc',
    text: 'Bearer abc.def-123 password=abc postgres://user:pass@localhost/db',
    key: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    note: 'Missing GITHUB_CLIENT_SECRET',
    project: '/Code/save-scum',
  };
  const result = redact(input);
  const serialized = JSON.stringify(result);
  for (const value of ['correct-horse', 'abcd', 'abc.def-123', 'user:pass', 'RSA PRIVATE KEY'])
    assert.ok(!serialized.includes(value));
  assert.equal(input.password, 'correct-horse');
  assert.equal(result.child[0].good, 5173);
  assert.equal(result.note, 'Missing GITHUB_CLIENT_SECRET');
  assert.equal(result.project, '/Code/save-scum');
  assert.equal(redactText('token="two words"'), 'token=[REDACTED]');
  assert.equal(
    redactText('{"password":"raw-secret","nested":{"apiKey":"a-secret"}}'),
    '{"password":"[REDACTED]","nested":{"apiKey":"[REDACTED]"}}',
  );
  assert.equal(redactText('run --password "two words"'), 'run --password [REDACTED]');
});

test('redaction handles cyclic host payloads without crashing', () => {
  const value: Record<string, unknown> = { nested: {} };
  value.self = value;
  assert.doesNotThrow(() => JSON.stringify(redact(value)));
});

test('redaction handles maximum-length unbroken log lines without quadratic scanning', () => {
  const longLine = 'x'.repeat(65536);
  const started = performance.now();
  for (let i = 0; i < 5; i++) assert.equal(redactText(longLine), longLine);
  assert.ok(
    performance.now() - started < 1000,
    'bounded-size ordinary logs must not block the host',
  );
});

test('repository aliases normalize common remote forms', () => {
  assert.equal(
    normalizeIdentity('git@github.com:Rippley777/save-scum.git'),
    'rippley777/save-scum',
  );
  assert.equal(
    normalizeIdentity('https://github.com/Rippley777/save-scum.git/'),
    'rippley777/save-scum',
  );
  assert.notEqual(normalizeIdentity('owner-one/app'), normalizeIdentity('owner-two/app'));
});
