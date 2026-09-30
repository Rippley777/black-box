import {
  createBlackBoxClient,
  type BlackBoxClient,
  type ProjectIdentity,
} from '@rippley/blackbox-sdk';

/** Structural subset of Port Authority's src/lib/types.ts; no cross-app import. */
export interface PortObservation {
  port: number;
  pid: number | null;
  process: string;
  command: string[];
  cwd: string | null;
  address: string;
  protocol: 'TCP' | 'UDP';
  protected: boolean;
  project?: {
    name: string;
    rootPath: string;
    repository?: { owner: string | null; repository: string } | null;
  } | null;
}
export interface PortAuthorityHandlers {
  inspectPort(port: number): unknown | Promise<unknown>;
  /** The host must recheck process identity, permissions, and its protected-process policy. */
  killProcess?(pid: number): unknown | Promise<unknown>;
  restartProcess?(pid: number): unknown | Promise<unknown>;
}
function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > maximum)
    throw new Error(`Invalid ${label}`);
  return Number(value);
}

export function createPortAuthorityIntegration(options: {
  version: string;
  handlers: PortAuthorityHandlers;
  client?: BlackBoxClient;
  projectFor?: (entry: PortObservation) => ProjectIdentity | undefined;
}) {
  const client =
    options.client ??
    createBlackBoxClient({
      app: 'port-authority',
      name: 'Port Authority',
      version: options.version,
    });
  let previous = new Map<string, PortObservation>();
  const projectFor =
    options.projectFor ??
    ((entry) =>
      entry.project
        ? {
            name: entry.project.name,
            path: entry.project.rootPath,
            repo: entry.project.repository?.owner
              ? `${entry.project.repository.owner}/${entry.project.repository.repository}`
              : undefined,
          }
        : entry.cwd
          ? { path: entry.cwd }
          : undefined);
  const key = (entry: PortObservation) =>
    `${entry.protocol}:${entry.address}:${entry.port}:${entry.pid}`;
  const payload = (entry: PortObservation, correlationId?: string) => ({
    project: projectFor(entry),
    correlationId,
    port: entry.port,
    pid: entry.pid,
    process: entry.process,
    command: entry.command.join(' '),
    address: entry.address,
    protocol: entry.protocol,
  });
  const ready = Promise.all([
    client.registerCapability(
      { name: 'port.inspect', description: 'Inspect a listening port in Port Authority' },
      (data) => options.handlers.inspectPort(positiveInteger(data.port, 'port', 65535)),
    ),
    ...(options.handlers.killProcess
      ? [
          client.registerCapability(
            {
              name: 'process.kill',
              description: 'Stop a process through Port Authority safeguards',
              requiresConfirmation: true,
            },
            (data) => {
              const pid = positiveInteger(data.pid, 'PID');
              const entry = [...previous.values()].find((item) => item.pid === pid);
              if (!entry || entry.protected) throw new Error('Process is unknown or protected');
              return options.handlers.killProcess!(pid);
            },
          ),
        ]
      : []),
    ...(options.handlers.restartProcess
      ? [
          client.registerCapability(
            {
              name: 'process.restart',
              description: 'Restart a known process through Port Authority',
              requiresConfirmation: true,
            },
            (data) => {
              const pid = positiveInteger(data.pid, 'PID');
              const entry = [...previous.values()].find((item) => item.pid === pid);
              if (!entry || entry.protected) throw new Error('Process is unknown or protected');
              return options.handlers.restartProcess!(pid);
            },
          ),
        ]
      : []),
  ]);
  return {
    client,
    ready,
    /** Call after a successful real scan. Failed scans must not be passed as empty snapshots. */
    async observePorts(entries: PortObservation[], correlationId?: string) {
      const next = new Map(entries.map((entry) => [key(entry), entry]));
      const oldPids = new Set([...previous.values()].map((entry) => entry.pid).filter(Boolean));
      for (const [id, entry] of next) {
        if (previous.has(id)) continue;
        await client.emit('port.opened', {
          ...payload(entry, correlationId),
          message: `${entry.process} listening on port ${entry.port}`,
          actions: [
            {
              id: `inspect-${entry.port}`,
              label: 'Inspect port',
              provider: client.appId,
              command: 'port.inspect',
              payload: { port: entry.port },
              requiresConfirmation: false,
            },
          ],
        });
        if (entry.pid && !oldPids.has(entry.pid)) {
          oldPids.add(entry.pid);
          await client.emit('process.started', {
            ...payload(entry, correlationId),
            message: `${entry.process} PID ${entry.pid} detected`,
          });
        }
      }
      for (const [id, entry] of previous) {
        if (next.has(id)) continue;
        await client.emit('port.closed', {
          ...payload(entry, correlationId),
          message: `Port ${entry.port} closed`,
        });
      }
      previous = next;
    },
    async processStopped(entry: PortObservation, exitCode: number | null, correlationId?: string) {
      return client.emit('process.stopped', {
        ...payload(entry, correlationId),
        exitCode,
        message: `${entry.process} PID ${entry.pid} exited`,
        severity: exitCode ? 'error' : 'info',
      });
    },
    async conflict(entry: PortObservation, requestedBy: string, correlationId?: string) {
      return client.emit('port.conflict_detected', {
        ...payload(entry, correlationId),
        severity: 'warning',
        message: `Port ${entry.port} is already in use`,
        requestedBy,
      });
    },
  };
}
