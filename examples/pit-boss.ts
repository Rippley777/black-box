import {
  createBlackBoxClient,
  type BlackBoxClient,
  type ProjectIdentity,
} from '@rippley/blackbox-sdk';

/** Structural subset of Pit Boss Run, intentionally excludes env and complete output. */
export interface ObservedRun {
  id: string;
  projectId: string;
  projectName: string;
  presetId: string;
  name: string;
  command: string;
  cwd: string;
  category: string;
  environment: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: 'running' | 'success' | 'failed' | 'stopped' | 'interrupted';
  pid: number | null;
  ports: number[];
}
export interface PitBossHandlers {
  /** Resolve IDs through the host's saved projects and presets, never execute supplied shell text. */
  runProject?(projectId: string, presetId: string): unknown | Promise<unknown>;
  stopProject?(projectId: string): unknown | Promise<unknown>;
  restartProject?(projectId: string): unknown | Promise<unknown>;
  deployProject?(projectId: string, presetId: string): unknown | Promise<unknown>;
}
function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error(`Invalid ${name}`);
  return value;
}
export function createPitBossIntegration(options: {
  version: string;
  handlers: PitBossHandlers;
  client?: BlackBoxClient;
}) {
  const client =
    options.client ??
    createBlackBoxClient({ app: 'pit-boss', name: 'Pit Boss', version: options.version });
  const registrations: Promise<boolean>[] = [];
  for (const [name, handler] of [
    ['project.run', options.handlers.runProject],
    ['project.deploy', options.handlers.deployProject],
  ] as const) {
    if (handler)
      registrations.push(
        client.registerCapability({ name, requiresConfirmation: true }, (data) =>
          handler(identifier(data.projectId, 'projectId'), identifier(data.presetId, 'presetId')),
        ),
      );
  }
  for (const [name, handler] of [
    ['project.stop', options.handlers.stopProject],
    ['project.restart', options.handlers.restartProject],
  ] as const) {
    if (handler)
      registrations.push(
        client.registerCapability({ name, requiresConfirmation: true }, (data) =>
          handler(identifier(data.projectId, 'projectId')),
        ),
      );
  }
  const project = (run: ObservedRun): ProjectIdentity => ({
    id: run.projectId,
    name: run.projectName,
    path: run.cwd,
  });
  return {
    client,
    ready: Promise.all(registrations),
    async recordRun(run: ObservedRun) {
      const lifecycle =
        run.status === 'running' ? 'started' : run.status === 'success' ? 'completed' : 'failed';
      const details = {
        project: project(run),
        correlationId: run.id,
        message: `${run.name} ${lifecycle}`,
        severity: (lifecycle === 'started'
          ? 'info'
          : lifecycle === 'completed'
            ? 'success'
            : 'error') as 'info' | 'success' | 'error',
        commandId: run.id,
        command: run.command,
        presetId: run.presetId,
        pid: run.pid,
        exitCode: run.exitCode,
        ports: run.ports,
        environment: run.environment,
        ...(lifecycle !== 'started' && run.endedAt
          ? { durationMs: run.endedAt - run.startedAt }
          : {}),
      };
      await client.emit(`command.${lifecycle}`, details);
      if (run.category === 'Deploy')
        await client.emit(`deploy.${lifecycle}`, { ...details, deploymentId: run.id });
    },
    output(run: ObservedRun, lines: string | string[], stream: 'stdout' | 'stderr' = 'stdout') {
      return client.ingestLogs(lines, { stream, project: project(run), correlationId: run.id });
    },
  };
}
