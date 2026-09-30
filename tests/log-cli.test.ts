import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../apps/daemon/src/index.js';

function run(endpoint: string, args: string[], stdin = '') {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/ingest-logs.ts', ...args], {
      env: { ...process.env, BLACKBOX_URL: endpoint },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (value) => {
      stderr += String(value);
    });
    child.stdout.resume();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Log CLI timed out'));
    }, 8000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.stdin.end(stdin);
  });
}

test('stdin and file ingestion deliver real redacted logs to SQLite', async () => {
  const daemon = createDaemon({ databasePath: ':memory:', port: 0 });
  const endpoint = await daemon.listen();
  const directory = mkdtempSync(join(tmpdir(), 'black-box-log-test-'));
  try {
    const piped = await run(
      endpoint,
      ['--app', 'pipeline-app', '--stream', 'stderr'],
      'request failed Bearer this-is-a-private-token\n{"password":"raw-json-secret"}\n',
    );
    assert.equal(piped.code, 0, piped.stderr);
    const file = join(directory, 'service.log');
    writeFileSync(file, '{"level":"warn","message":"Missing API_URL"}\nListening on port 5173');
    const attached = await run(endpoint, ['--app', 'file-app', '--file', file]);
    assert.equal(attached.code, 0, attached.stderr);
    const events = daemon.store.query().events;
    assert.equal(events.length, 4);
    assert.ok(events.some((e) => e.message === 'Listening on port 5173'));
    assert.equal(events.find((e) => e.message === 'Missing API_URL')?.severity, 'warning');
    const exported = await fetch(`${endpoint}/export`).then((r) => r.text());
    assert.ok(!exported.includes('this-is-a-private-token'));
    assert.ok(!exported.includes('raw-json-secret'));
    assert.ok(exported.includes('[REDACTED]'));
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
