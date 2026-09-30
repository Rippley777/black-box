import { createReadStream, watchFile, unwatchFile, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DEFAULT_ENDPOINT, redactText } from '@rippley/blackbox-protocol';

const args = process.argv.slice(2);
const option = (key: string) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
if (args.includes('--help')) {
  console.log(
    'Usage: npm run logs -- --app pit-boss [--project save-scum] [--stream stdout|stderr] [--file ./app.log] [--follow]\nOr pipe a process: your-command 2>&1 | npm run logs -- --app your-app',
  );
  process.exit(0);
}
const app = option('--app') ?? 'manual-logs';
const projectId = option('--project');
const file = option('--file');
const stream = option('--stream') ?? (file ? 'file' : 'stdout');
const endpoint = process.env.BLACKBOX_URL ?? DEFAULT_ENDPOINT;
if (!['file', 'stdout', 'stderr'].includes(stream)) throw new Error('Invalid --stream');
const pending: string[] = [];
let sent = 0;
let dropped = 0;
let flushing: Promise<void> | undefined;
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    while (pending.length) {
      const batch = pending.splice(0, 100);
      try {
        const response = await fetch(`${endpoint}/logs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: { app },
            project: projectId ? { id: projectId } : undefined,
            stream,
            lines: batch,
          }),
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        sent += batch.length;
      } catch {
        pending.unshift(...batch);
        break;
      }
    }
  })().finally(() => {
    flushing = undefined;
  });
  return flushing;
}
function line(value: string) {
  if (pending.length >= 1000) {
    pending.shift();
    dropped++;
  }
  // Keep individual lines and offline memory bounded; redact before queueing.
  pending.push(redactText(value.slice(0, 32768)));
}
const timer = setInterval(() => {
  void flush();
}, 1000);
let carry = '';
let fileRead: Promise<void> = Promise.resolve();
let offset = 0;
async function readFileRange(start: number, end: number) {
  if (!file || end <= start) return;
  for await (const chunk of createReadStream(file, { start, end: end - 1, encoding: 'utf8' })) {
    const lines = (carry + chunk).split(/\r?\n/);
    carry = lines.pop() ?? '';
    lines.forEach(line);
    if (carry.length > 32768) {
      line(carry);
      carry = '';
    }
    await flush();
  }
}
async function finish() {
  clearInterval(timer);
  if (file) unwatchFile(file);
  await fileRead;
  if (carry) {
    line(carry);
    carry = '';
  }
  await flush();
  console.error(`BLACK BOX: ${sent} lines ingested; ${pending.length} unsent; ${dropped} dropped.`);
  process.exitCode = pending.length || dropped ? 1 : 0;
}
if (file) {
  offset = statSync(file).size;
  await readFileRange(0, offset);
  if (args.includes('--follow')) {
    watchFile(file, { interval: 500 }, (current, previous) => {
      if (!current.nlink) return;
      if (current.size < offset || current.ino !== previous.ino) {
        offset = 0;
        carry = '';
      }
      const start = offset;
      offset = current.size;
      fileRead = fileRead
        .then(() => readFileRange(start, current.size))
        .catch((error) => console.error(`Log file read failed: ${error.message}`));
    });
    process.once('SIGINT', () => {
      void finish();
    });
    process.once('SIGTERM', () => {
      void finish();
    });
  } else await finish();
} else {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const value of reader) {
    line(value);
    if (pending.length >= 100) await flush();
  }
  await finish();
}
