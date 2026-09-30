import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0' as const;
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:47821';
export const severitySchema = z.enum(['debug', 'info', 'success', 'warning', 'error', 'critical']);
export type Severity = z.infer<typeof severitySchema>;
const text = z.string().min(1).max(1024);
const identifier = z.string().min(1).max(200);
export const projectIdentitySchema = z
  .object({
    id: identifier.optional(),
    name: text.optional(),
    path: text.optional(),
    repo: text.optional(),
  })
  .refine((p) => !!(p.id || p.name || p.path || p.repo), 'A project needs at least one identity');
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;
export const actionSchema = z.object({
  id: identifier,
  label: text,
  provider: identifier,
  command: identifier,
  payload: z.record(z.unknown()).default({}),
  requiresConfirmation: z.boolean().default(false),
});
export type EventAction = z.infer<typeof actionSchema>;
export const eventSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  id: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  source: z.object({
    app: identifier,
    instanceId: identifier.optional(),
    version: text.optional(),
  }),
  type: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/)
    .max(200),
  severity: severitySchema.default('info'),
  message: z.string().max(65536),
  project: projectIdentitySchema.optional(),
  data: z.record(z.unknown()).default({}),
  correlationId: identifier.optional(),
  parentEventId: z.string().uuid().optional(),
  tags: z.array(z.string().max(200)).max(50).default([]),
  metadata: z.record(z.unknown()).default({}),
  actions: z.array(actionSchema).max(30).default([]),
});
export type RippleyEvent = z.infer<typeof eventSchema>;
export type StoredEvent = RippleyEvent & { sequence: number; groupId?: string };
export type EventInput = Omit<Partial<RippleyEvent>, 'source' | 'type'> & {
  type: string;
  source?: RippleyEvent['source'];
};
export const projectSchema = z.object({
  id: identifier,
  name: text,
  paths: z.array(text).default([]),
  repo: text.optional(),
  remoteUrl: text.optional(),
  domains: z.array(text).default([]),
  environments: z.array(text).default([]),
  commands: z.array(text).default([]),
  processes: z.array(z.number().int().positive()).default([]),
  applications: z.array(identifier).default([]),
  aliases: z.array(text).default([]),
});
export type ProjectRecord = z.infer<typeof projectSchema>;
export const capabilitySchema = z.object({
  name: identifier,
  description: text.optional(),
  requiresConfirmation: z.boolean().default(false),
});
export type Capability = z.infer<typeof capabilitySchema>;
export const applicationSchema = z.object({
  id: identifier,
  name: text,
  version: text.default('0.0.0'),
  instanceId: identifier.optional(),
  capabilities: z.array(capabilitySchema).default([]),
  subscriptions: z.array(text).default([]),
  actions: z.array(actionSchema).default([]),
  health: z.enum(['healthy', 'warning', 'error']).default('healthy'),
});
export type ApplicationRegistration = z.infer<typeof applicationSchema>;
export type ApplicationRecord = ApplicationRegistration & {
  lastHeartbeat: string;
  connected: boolean;
};
export interface EventQuery {
  order?: 'timestamp' | 'sequence';
  q?: string;
  project?: string;
  source?: string;
  type?: string;
  severity?: string;
  port?: number;
  pid?: number;
  repo?: string;
  command?: string;
  tag?: string;
  from?: string;
  to?: string;
  correlationId?: string;
  limit?: number;
  before?: number;
  after?: number;
}
export interface QueryResult {
  events: StoredEvent[];
  total: number;
  nextCursor?: number;
}
export interface EventContext {
  groupId: string;
  events: StoredEvent[];
  summary: string;
  reasons: string[];
}
export interface Incident {
  id: string;
  title: string;
  projectId?: string;
  status: 'open' | 'resolved';
  startedAt: string;
  resolvedAt?: string;
  eventIds: string[];
  summary: string;
  sources: string[];
}
export interface CommandRecord {
  id: string;
  provider: string;
  command: string;
  payload: Record<string, unknown>;
  correlationId: string;
  status: 'pending' | 'accepted' | 'completed' | 'failed' | 'timeout';
  createdAt: string;
  expiresAt: string;
  result?: unknown;
  error?: string;
}
export interface CommandInput {
  provider?: string;
  command: string;
  payload?: Record<string, unknown>;
  correlationId?: string;
  confirmed?: boolean;
  timeoutMs?: number;
}
export type StreamMessage =
  | { kind: 'event'; event: StoredEvent; replay?: boolean }
  | { kind: 'command'; command: CommandRecord }
  | { kind: 'ready'; latestSequence: number }
  | { kind: 'error'; message: string };
export interface RetentionPolicy {
  debug: number | null;
  info: number | null;
  success: number | null;
  warning: number | null;
  error: number | null;
  critical: number | null;
}
export const DEFAULT_RETENTION: RetentionPolicy = {
  debug: 7,
  info: 30,
  success: 30,
  warning: 90,
  error: null,
  critical: null,
};

/** A dot-delimited wildcard; matching is intentionally transport-independent. */
export function matchesPattern(type: string, pattern: string): boolean {
  return new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  ).test(type);
}

const sensitiveKey =
  /(?:password|passwd|secret|token|authorization|api[_-]?key|private[_-]?key|connection[_-]?string|database[_-]?url|access[_-]?key|cookie)/i;
export function redactText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, 'Basic [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      '[REDACTED]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /("[^"\n]*(?:password|passwd|secret|token|authorization|api[_-]?key|private[_-]?key|connection[_-]?string|database[_-]?url|access[_-]?key|cookie)[^"\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /(--(?:password|passwd|secret|token|api[_-]?key)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b((?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|DATABASE_URL|CONNECTION_STRING)[A-Z0-9_]*)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    );
}
/** Redact before persistence, broadcasting and offline buffering. Never mutates input. */
export function redact<T>(input: T): T {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redactText(value);
    if (!value || typeof value !== 'object') return value;
    if (depth > 30 || seen.has(value)) return '[REDACTED COMPLEX VALUE]';
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map((v) => visit(v, depth + 1))
      : Object.fromEntries(
          Object.entries(value).map(([key, v]) => [
            key,
            sensitiveKey.test(key) ? '[REDACTED]' : visit(v, depth + 1),
          ]),
        );
    seen.delete(value);
    return result;
  };
  return visit(input, 0) as T;
}

/** Normalize explicit aliases without conflating repositories with the same basename. */
export function normalizeIdentity(input: string): string {
  return input
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git\/?$/, '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}
