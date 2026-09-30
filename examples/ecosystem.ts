/** Run with `npm run example` while the daemon is running. No sibling app is changed. */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createBlackBoxClient } from '@rippley/blackbox-sdk';
import { createPortAuthorityIntegration, type PortObservation } from './port-authority.js';
import { createPitBossIntegration, type ObservedRun } from './pit-boss.js';
import { createEnvReaperIntegration, type EnvironmentScan } from './env-reaper.js';

const project = { id: 'black-box-sandbox', name: 'Black Box SDK sandbox', path: process.cwd() };
const correlationId = randomUUID();
const childScript = `
const net = require('node:net');
const server = net.createServer(socket => socket.end('black-box-sandbox\\n'));
server.listen(0, '127.0.0.1', () => {
  console.log('Sandbox TCP listener started');
  process.send({ port: server.address().port });
});
process.on('message', message => {
  if (message === 'stop') server.close(() => { console.log('Sandbox TCP listener stopped'); process.exit(0); });
});
`;
const child = spawn(process.execPath, ['-e', childScript], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
const exit = new Promise<number | null>((resolve, reject) => {
  child.once('exit', resolve);
  child.once('error', reject);
});
// Always observe the promise, including failures before the port handshake.
void exit.catch(() => {});
const clients = ['port-authority', 'pit-boss', 'env-reaper'].map((app) =>
  createBlackBoxClient({
    app: `${app}-example`,
    name: `${app
      .split('-')
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(' ')} · SDK example`,
    version: '0.1.0',
  }),
);
const [portClient, pitClient, envClient] = clients;
const run: ObservedRun = {
  id: correlationId,
  projectId: project.id,
  projectName: project.name,
  presetId: 'sandbox-listener',
  name: 'Sandbox TCP listener',
  command: 'node [bundled sandbox listener]',
  cwd: project.path,
  category: 'Development',
  environment: 'local',
  startedAt: Date.now(),
  endedAt: null,
  exitCode: null,
  status: 'running',
  pid: child.pid ?? null,
  ports: [],
};
const ensureProject = (id: string) => {
  if (id !== project.id) throw new Error('This example only controls its sandbox project');
};
const stopOwnedProcess = async () => {
  if (child.exitCode === null && child.connected) child.send('stop');
  await exit;
  return { stopped: true, pid: child.pid };
};
const pit = createPitBossIntegration({
  version: '0.1.0',
  client: pitClient,
  handlers: {
    stopProject: (id) => {
      ensureProject(id);
      return stopOwnedProcess();
    },
  },
});
const validate = async (id: string): Promise<EnvironmentScan> => {
  ensureProject(id);
  const start = performance.now();
  // Inspect only presence. Never copy, log, hash, or publish an environment value.
  const names = ['PATH', 'BLACKBOX_SAMPLE_REQUIRED'];
  return {
    name: project.name,
    path: project.path,
    scannedAt: new Date().toISOString(),
    files: 0,
    duration: performance.now() - start,
    environments: ['process'],
    variables: names.map((name) => ({
      name,
      status: process.env[name] ? ('healthy' as const) : ('missing' as const),
      secret: false,
      drifted: false,
    })),
  };
};
const env = createEnvReaperIntegration({ version: '0.1.0', client: envClient, validate });
child.stdout?.on('data', (chunk) => {
  void pit.output(run, String(chunk), 'stdout');
});
child.stderr?.on('data', (chunk) => {
  void pit.output(run, String(chunk), 'stderr');
});

try {
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sandbox listener did not start')), 5_000);
    child.once('message', (message) => {
      clearTimeout(timer);
      const value = (message as { port?: unknown }).port;
      if (typeof value !== 'number') reject(new Error('Invalid sandbox handshake'));
      else resolve(value);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  run.ports = [port];
  const portAuthority = createPortAuthorityIntegration({
    version: '0.1.0',
    client: portClient,
    projectFor: () => project,
    handlers: {
      inspectPort: (requested) =>
        new Promise((resolve, reject) => {
          if (requested !== port) {
            reject(new Error('This example only inspects its own listening port'));
            return;
          }
          const socket = createConnection({ host: '127.0.0.1', port }, () => {
            socket.end();
            resolve({ port, pid: child.pid, reachable: true, address: '127.0.0.1' });
          });
          socket.setTimeout(1_000, () => socket.destroy(new Error('Sandbox probe timed out')));
          socket.once('error', reject);
        }),
      killProcess: (pid) => {
        if (pid !== child.pid) throw new Error('This example only stops its own child process');
        return stopOwnedProcess();
      },
    },
  });
  await Promise.all(
    clients.map((client) =>
      client.identifyProject({
        id: project.id,
        name: project.name,
        paths: [project.path],
        aliases: ['SDK sandbox'],
        commands: [run.command],
        processes: child.pid ? [child.pid] : [],
        applications: clients.map((client) => client.appId),
        environments: ['local'],
      }),
    ),
  );
  await Promise.all([portAuthority.ready, pit.ready, env.ready]);
  const observation: PortObservation = {
    port,
    pid: child.pid ?? null,
    process: 'node',
    command: ['node', '[bundled sandbox listener]'],
    cwd: process.cwd(),
    address: '127.0.0.1',
    protocol: 'TCP',
    protected: false,
  };
  await pit.recordRun(run);
  await portAuthority.observePorts([observation], correlationId);
  await env.recordScan(await validate(project.id), project, correlationId);
  const deadline = Date.now() + 5_000;
  while (!clients.every((client) => client.stats.connected) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (clients.every((client) => client.stats.connected)) {
    const inspected = await pitClient.request({
      provider: portClient.appId,
      command: 'port.inspect',
      payload: { port },
      correlationId,
    });
    console.log('Routed port.inspect:', inspected?.status, inspected?.result);
    const validated = await pitClient.request({
      provider: envClient.appId,
      command: 'environment.validate',
      payload: { projectId: project.id },
      correlationId,
    });
    console.log('Routed environment.validate:', validated?.status, validated?.result);
  } else
    console.log(
      'Daemon unavailable: host work continued; buffered events will be dropped when this short-lived example closes.',
    );
  // Stop only the child created above. No arbitrary shell or existing process is touched.
  await stopOwnedProcess();
  run.status = child.exitCode === 0 ? 'success' : 'failed';
  run.exitCode = child.exitCode;
  run.endedAt = Date.now();
  await portAuthority.observePorts([], correlationId);
  await portAuthority.processStopped(observation, run.exitCode, correlationId);
  await pit.recordRun(run);
  await Promise.all(clients.map((client) => client.flush()));
  console.log(
    `Recorded actual process, port, command, logs, and environment metadata for ${project.name}.`,
  );
} finally {
  if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  for (const client of clients) client.close();
}
