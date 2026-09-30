import {
  createBlackBoxClient,
  type BlackBoxClient,
  type ProjectIdentity,
} from '@rippley/blackbox-sdk';

/** Structural subset of Env Reaper Scan. Values and fingerprints are deliberately absent. */
export interface EnvironmentScan {
  name: string;
  path: string;
  scannedAt: string;
  files: number;
  duration: number;
  environments: string[];
  variables: {
    name: string;
    status: 'healthy' | 'missing' | 'dead' | 'exposed' | 'unknown';
    secret: boolean;
    drifted: boolean;
  }[];
  demo?: boolean;
}
export function createEnvReaperIntegration(options: {
  version: string;
  client?: BlackBoxClient;
  /** Use the host's project registry and real scanner. Do not return environment values. */
  validate(projectId: string): EnvironmentScan | Promise<EnvironmentScan>;
  open?(projectId: string): unknown | Promise<unknown>;
}) {
  const client =
    options.client ??
    createBlackBoxClient({ app: 'env-reaper', name: 'Env Reaper', version: options.version });
  const requireId = (input: unknown) => {
    if (typeof input !== 'string' || !input.trim() || input.length > 200)
      throw new Error('Invalid projectId');
    return input;
  };
  const recordScan = async (
    scan: EnvironmentScan,
    identity?: ProjectIdentity,
    correlationId?: string,
  ) => {
    if (scan.demo) return; // Never ingest the host application's bundled demo fixtures.
    const project = identity ?? { name: scan.name, path: scan.path };
    const base = { project, correlationId };
    for (const variable of scan.variables) {
      if (variable.status === 'missing')
        await client.emit('environment.missing_variable', {
          ...base,
          severity: 'warning',
          message: `Missing environment variable ${variable.name}`,
          variable: variable.name,
        });
      if (variable.status === 'exposed')
        await client.emit('environment.secret_detected', {
          ...base,
          severity: 'error',
          message: `Exposed environment variable ${variable.name}`,
          variable: variable.name,
        });
      if (variable.drifted)
        await client.emit('environment.changed', {
          ...base,
          severity: 'warning',
          message: `Environment definition drift detected for ${variable.name}`,
          variable: variable.name,
        });
    }
    const missing = scan.variables.filter((variable) => variable.status === 'missing').length;
    const exposed = scan.variables.filter((variable) => variable.status === 'exposed').length;
    await client.emit('environment.scan.completed', {
      ...base,
      severity: missing || exposed ? 'warning' : 'success',
      message: `Environment scan complete: ${missing} missing, ${exposed} exposed`,
      variableCount: scan.variables.length,
      missing,
      exposed,
      files: scan.files,
      durationMs: scan.duration,
      environments: scan.environments,
    });
    return { missing, exposed, variableCount: scan.variables.length };
  };
  const ready = Promise.all([
    client.registerCapability(
      {
        name: 'environment.validate',
        description: 'Validate project environment names and metadata',
      },
      async (data, command) => {
        const projectId = requireId(data.projectId);
        const scan = await options.validate(projectId);
        return recordScan(
          scan,
          { id: projectId, name: scan.name, path: scan.path },
          command.correlationId,
        );
      },
    ),
    ...(options.open
      ? [
          client.registerCapability(
            {
              name: 'environment.open',
              description: 'Open an environment project',
              requiresConfirmation: true,
            },
            (data) => options.open!(requireId(data.projectId)),
          ),
        ]
      : []),
  ]);
  return { client, ready, recordScan };
}
