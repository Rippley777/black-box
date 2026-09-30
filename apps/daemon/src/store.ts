import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_RETENTION,
  applicationSchema,
  eventSchema,
  normalizeIdentity,
  projectSchema,
  redact,
  type ApplicationRecord,
  type ApplicationRegistration,
  type CommandRecord,
  type EventContext,
  type EventQuery,
  type Incident,
  type ProjectRecord,
  type QueryResult,
  type RetentionPolicy,
  type RippleyEvent,
  type StoredEvent,
} from '@rippley/blackbox-protocol';

type Row = { sequence: number; body: string; group_id: string };
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const parse = <T>(row: { body: string }): T => JSON.parse(row.body) as T;
const eventFromRow = (row: Row): StoredEvent => ({
  ...parse<RippleyEvent>(row),
  sequence: row.sequence,
  groupId: row.group_id,
});
// Path identity remains case-sensitive; do not equate unrelated directories by basename.
const identityKey = (s: string) =>
  /^(?:\/|[A-Za-z]:[\\/])/.test(s.trim())
    ? s.trim().replace(/\\/g, '/').replace(/\/$/, '')
    : normalizeIdentity(s);
const aliases = (p: ProjectRecord) => [
  ...new Set(
    [p.id, p.name, ...p.paths, p.repo, p.remoteUrl, ...p.aliases]
      .filter((x): x is string => !!x)
      .map(identityKey),
  ),
];
const scalar = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);

export class Store {
  readonly db: Database.Database;
  constructor(path: string | Buffer) {
    if (typeof path === 'string' && path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (Number(this.db.pragma('user_version', { simple: true })) > 1) {
      this.db.close();
      throw new Error('This database requires a newer version of Black Box');
    }
    if (typeof path === 'string' && path !== ':memory:' && process.platform !== 'win32')
      chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL,
        source TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL, project_id TEXT,
        correlation_id TEXT, parent_id TEXT, pid TEXT, port TEXT, command_id TEXT, deployment_id TEXT,
        command TEXT, repo TEXT, group_id TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(timestamp);
      CREATE INDEX IF NOT EXISTS events_project_time ON events(project_id,timestamp);
      CREATE INDEX IF NOT EXISTS events_source_time ON events(source,timestamp);
      CREATE INDEX IF NOT EXISTS events_type_time ON events(type,timestamp);
      CREATE INDEX IF NOT EXISTS events_severity_time ON events(severity,timestamp);
      CREATE INDEX IF NOT EXISTS events_correlation ON events(correlation_id);
      CREATE INDEX IF NOT EXISTS events_group ON events(group_id);
      CREATE INDEX IF NOT EXISTS events_pid ON events(pid);
      CREATE INDEX IF NOT EXISTS events_port ON events(port);
      CREATE INDEX IF NOT EXISTS events_parent ON events(parent_id);
      CREATE INDEX IF NOT EXISTS events_command_id ON events(command_id);
      CREATE INDEX IF NOT EXISTS events_deployment_id ON events(deployment_id);
      CREATE INDEX IF NOT EXISTS events_repo ON events(repo);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_aliases (alias TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capabilities (app_id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(app_id,name));
      CREATE TABLE IF NOT EXISTS actions (app_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(app_id,id));
      CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS correlations (event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE, group_id TEXT NOT NULL, reasons TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS commands_expiry ON commands(status,expires_at);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }

  project(id: string): ProjectRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT p.body FROM projects p LEFT JOIN project_aliases a ON a.project_id=p.id WHERE p.id=? OR a.alias=? LIMIT 1',
      )
      .get(id, identityKey(id)) as { body: string } | undefined;
    return row && parse<ProjectRecord>(row);
  }
  projects(): ProjectRecord[] {
    return (
      this.db.prepare('SELECT body FROM projects ORDER BY id').all() as { body: string }[]
    ).map(parse<ProjectRecord>);
  }
  registerProject(input: unknown): ProjectRecord {
    const parsed = projectSchema.parse(redact(input));
    const existing = this.project(parsed.id);
    const p =
      existing?.id === parsed.id
        ? {
            ...existing,
            ...parsed,
            repo: parsed.repo ?? existing.repo,
            remoteUrl: parsed.remoteUrl ?? existing.remoteUrl,
          }
        : parsed;
    if (existing?.id === p.id)
      for (const key of [
        'paths',
        'domains',
        'environments',
        'commands',
        'processes',
        'applications',
        'aliases',
      ] as const) {
        Object.assign(p, { [key]: [...new Set([...existing[key], ...parsed[key]])] });
      }
    this.db.transaction(() => {
      for (const alias of aliases(p)) {
        const existing = this.db
          .prepare('SELECT project_id FROM project_aliases WHERE alias=?')
          .get(alias) as { project_id: string } | undefined;
        if (existing && existing.project_id !== p.id)
          throw new ApiError(
            409,
            `Project alias already belongs to ${existing.project_id}: ${alias}`,
          );
      }
      this.db
        .prepare(
          'INSERT INTO projects(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(p.id, JSON.stringify(p));
      this.db.prepare('DELETE FROM project_aliases WHERE project_id=?').run(p.id);
      const insert = this.db.prepare('INSERT INTO project_aliases(alias,project_id) VALUES(?,?)');
      for (const alias of aliases(p)) insert.run(alias, p.id);
    })();
    return p;
  }
  private resolveProject(event: RippleyEvent): RippleyEvent {
    if (!event.project) return event;
    const identities = Object.values(event.project).filter(Boolean);
    const matches = [
      ...new Map(
        identities
          .map((v) => this.project(v))
          .filter((v): v is ProjectRecord => !!v)
          .map((v) => [v.id, v]),
      ).values(),
    ];
    if (matches.length > 1)
      throw new ApiError(409, 'Event project identities refer to different registered projects');
    if (event.project.id && matches.length && !this.project(event.project.id))
      throw new ApiError(
        409,
        'Unknown stable project ID conflicts with another project alias; register the identity explicitly',
      );
    let p = matches[0];
    if (!p && event.project.id) {
      p = this.registerProject({
        id: event.project.id,
        name: event.project.name ?? event.project.id,
        paths: event.project.path ? [event.project.path] : [],
        repo: event.project.repo,
      });
    }
    return p
      ? {
          ...event,
          project: { ...event.project, id: p.id, name: p.name, repo: event.project.repo ?? p.repo },
        }
      : event;
  }
  applications(isConnected: (id: string) => boolean): ApplicationRecord[] {
    return (
      this.db.prepare('SELECT body FROM applications ORDER BY id').all() as { body: string }[]
    ).map((row) => {
      const a = parse<ApplicationRecord>(row);
      return { ...a, connected: isConnected(a.id) };
    });
  }
  application(id: string): ApplicationRecord | undefined {
    const row = this.db.prepare('SELECT body FROM applications WHERE id=?').get(id) as
      { body: string } | undefined;
    return row && parse<ApplicationRecord>(row);
  }
  registerApplication(input: unknown): ApplicationRecord {
    const registration = applicationSchema.parse(redact(input));
    const a = { ...registration, lastHeartbeat: new Date().toISOString(), connected: false };
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO applications(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(a.id, JSON.stringify(a));
      this.db.prepare('DELETE FROM capabilities WHERE app_id=?').run(a.id);
      this.db.prepare('DELETE FROM actions WHERE app_id=?').run(a.id);
      for (const c of a.capabilities)
        this.db
          .prepare('INSERT INTO capabilities(app_id,name,body) VALUES(?,?,?)')
          .run(a.id, c.name, JSON.stringify(c));
      for (const action of a.actions)
        this.db
          .prepare('INSERT INTO actions(app_id,id,body) VALUES(?,?,?)')
          .run(a.id, action.id, JSON.stringify(action));
    })();
    return a;
  }
  heartbeat(id: string, health?: ApplicationRegistration['health']): ApplicationRecord {
    const a = this.application(id);
    if (!a) throw new ApiError(404, 'Application is not registered');
    a.lastHeartbeat = new Date().toISOString();
    if (health) a.health = health;
    this.db.prepare('UPDATE applications SET body=? WHERE id=?').run(JSON.stringify(a), id);
    return a;
  }

  ingest(input: unknown): { events: StoredEvent[]; fresh: StoredEvent[] } {
    const batch = Array.isArray(input) ? input : [input];
    if (!batch.length || batch.length > 500)
      throw new ApiError(400, 'Publish between 1 and 500 events per request');
    // Validate the entire batch before any writes. Redaction happens before every persistence path.
    const validated = batch.map((v) => {
      const event = eventSchema.parse(redact(v));
      return { ...event, timestamp: new Date(event.timestamp).toISOString() };
    });
    return this.db.transaction(() => {
      const fresh: StoredEvent[] = [];
      const ids: string[] = [];
      for (let event of validated) {
        ids.push(event.id);
        if (this.event(event.id)) continue;
        event = this.resolveProject(event);
        if (!this.application(event.source.app))
          this.registerApplication({
            id: event.source.app,
            name: event.source.app,
            version: event.source.version,
          });
        const related = this.related(event);
        const groupId = related[0]?.event.groupId ?? `group-${event.id}`;
        for (const group of new Set(
          related.map((r) => r.event.groupId).filter((g) => g && g !== groupId),
        )) {
          this.db.prepare('UPDATE events SET group_id=? WHERE group_id=?').run(groupId, group);
          this.db
            .prepare('UPDATE correlations SET group_id=? WHERE group_id=?')
            .run(groupId, group);
        }
        const result = this.db
          .prepare(
            `INSERT INTO events(id,timestamp,source,type,severity,project_id,correlation_id,parent_id,pid,port,command_id,deployment_id,command,repo,group_id,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            event.id,
            event.timestamp,
            event.source.app,
            event.type,
            event.severity,
            event.project?.id ?? null,
            event.correlationId ?? null,
            event.parentEventId ?? null,
            scalar(event.data.pid),
            scalar(event.data.port),
            scalar(event.data.commandId),
            scalar(event.data.deploymentId),
            scalar(event.data.command),
            event.project?.repo ? normalizeIdentity(event.project.repo) : null,
            groupId,
            JSON.stringify(event),
          );
        this.db
          .prepare('INSERT INTO correlations(event_id,group_id,reasons) VALUES(?,?,?)')
          .run(event.id, groupId, JSON.stringify([...new Set(related.flatMap((r) => r.reasons))]));
        fresh.push({ ...event, sequence: Number(result.lastInsertRowid), groupId });
      }
      return {
        events: ids.map((id) => this.event(id)!),
        fresh: fresh.map((e) => this.event(e.id)!),
      };
    })();
  }
  private related(event: RippleyEvent): { event: StoredEvent; reasons: string[] }[] {
    const min = new Date(Date.parse(event.timestamp) - 120_000).toISOString();
    const max = new Date(Date.parse(event.timestamp) + 120_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT sequence,body,group_id FROM events WHERE
      (correlation_id IS NOT NULL AND correlation_id=?) OR id=? OR parent_id=? OR
      (timestamp BETWEEN ? AND ? AND ((project_id IS NOT NULL AND project_id=?) OR
        (pid IS NOT NULL AND pid=?) OR (port IS NOT NULL AND port=?) OR (command_id IS NOT NULL AND command_id=?) OR (deployment_id IS NOT NULL AND deployment_id=?) OR (repo IS NOT NULL AND repo=?)))
      ORDER BY sequence ASC LIMIT 2000`,
      )
      .all(
        event.correlationId ?? null,
        event.parentEventId ?? null,
        event.id,
        min,
        max,
        event.project?.id ?? null,
        scalar(event.data.pid),
        scalar(event.data.port),
        scalar(event.data.commandId),
        scalar(event.data.deploymentId),
        event.project?.repo ? normalizeIdentity(event.project.repo) : null,
      ) as Row[];
    const bounds = new Map<string, { start: string; end: string }>();
    return rows
      .map(eventFromRow)
      .map((other) => {
        const reasons: string[] = [];
        if (event.correlationId && other.correlationId === event.correlationId)
          reasons.push(`Shared correlation ID ${event.correlationId}`);
        if (other.id === event.parentEventId || other.parentEventId === event.id)
          reasons.push('Explicit parent event relationship');
        let span = bounds.get(other.groupId!);
        if (!span) {
          span = this.db
            .prepare(
              'SELECT MIN(timestamp) AS start,MAX(timestamp) AS end FROM events WHERE group_id=?',
            )
            .get(other.groupId) as { start: string; end: string };
          bounds.set(other.groupId!, span);
        }
        const withinGroupWindow =
          Math.max(Date.parse(span.end), Date.parse(event.timestamp)) -
            Math.min(Date.parse(span.start), Date.parse(event.timestamp)) <=
          600_000;
        const near =
          Math.abs(Date.parse(other.timestamp) - Date.parse(event.timestamp)) <= 120_000 &&
          withinGroupWindow;
        // Reused machine ports/PIDs must never merge two known, different projects.
        const compatible =
          !event.project?.id || !other.project?.id || event.project.id === other.project.id;
        if (near && compatible) {
          if (event.project?.id && event.project.id === other.project?.id)
            reasons.push(`Same project ${event.project.id} within 2 minutes`);
          for (const key of ['pid', 'port', 'commandId', 'deploymentId'] as const)
            if (
              scalar(event.data[key]) !== null &&
              scalar(event.data[key]) === scalar(other.data[key])
            )
              reasons.push(`Shared ${key} ${scalar(event.data[key])} within 2 minutes`);
          if (
            event.project?.repo &&
            other.project?.repo &&
            normalizeIdentity(event.project.repo) === normalizeIdentity(other.project.repo)
          )
            reasons.push('Same repository within 2 minutes');
        }
        return { event: other, reasons };
      })
      .filter((r) => r.reasons.length);
  }
  event(id: string): StoredEvent | undefined {
    const row = this.db.prepare('SELECT sequence,body,group_id FROM events WHERE id=?').get(id) as
      Row | undefined;
    return row && eventFromRow(row);
  }
  latestSequence(): number {
    return (
      this.db
        .prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) AS n")
        .get() as { n: number }
    ).n;
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  }

  query(input: EventQuery = {}, ascending = false, maxLimit = 500): QueryResult {
    const q = { ...input };
    if (q.order !== undefined && !['timestamp', 'sequence'].includes(q.order))
      throw new ApiError(400, 'order must be timestamp or sequence');
    // Transport replay/export must keep durable ingest order, even when a caller
    // requests presentation order. The timeline opts in to event timestamps.
    const timestampOrder = !ascending && q.order === 'timestamp';
    const terms: string[] = [];
    const recognized = new Set([
      'project',
      'source',
      'app',
      'type',
      'severity',
      'port',
      'pid',
      'repo',
      'command',
      'tag',
      'from',
      'to',
      'correlationId',
    ]);
    for (const token of (q.q ?? '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
      const index = token.indexOf(':');
      const key = token.slice(0, index);
      const value = (index > 0 ? token.slice(index + 1) : token).replace(/^(["'])(.*)\1$/, '$2');
      if (index > 0 && recognized.has(key))
        Object.assign(q, { [key === 'app' ? 'source' : key]: value });
      else terms.push(token.replace(/^(["'])(.*)\1$/, '$2'));
    }
    const clauses: string[] = [],
      values: (string | number)[] = [];
    const where = (clause: string, value: string | number) => {
      clauses.push(clause);
      values.push(value);
    };
    for (const key of ['source', 'severity', 'pid', 'port', 'correlationId'] as const)
      if (q[key] !== undefined && q[key] !== '')
        where(`${key === 'correlationId' ? 'correlation_id' : key}=?`, q[key]!);
    if (q.project) where('project_id=?', this.project(q.project)?.id ?? q.project);
    if (q.repo) where('repo=?', normalizeIdentity(q.repo));
    const like = (s: string) => s.replace(/[\\%_]/g, '\\$&');
    if (q.type) where("type LIKE ? ESCAPE '\\'", like(q.type).replace(/\*/g, '%'));
    if (q.command) where("command LIKE ? ESCAPE '\\'", `%${like(q.command)}%`);
    if (q.tag) where("EXISTS (SELECT 1 FROM json_each(events.body,'$.tags') WHERE value=?)", q.tag);
    for (const [key, operator] of [
      ['from', '>='],
      ['to', '<='],
    ] as const)
      if (q[key]) {
        const date = new Date(q[key]!);
        if (!Number.isFinite(date.getTime())) throw new ApiError(400, `Invalid ${key} date`);
        where(`julianday(timestamp) ${operator} julianday(?)`, date.toISOString());
      }
    for (const [key, op] of [
      ['before', '<'],
      ['after', '>'],
    ] as const)
      if (q[key] !== undefined) {
        if (!Number.isSafeInteger(Number(q[key])) || Number(q[key]) < 0)
          throw new ApiError(400, `Invalid ${key} cursor`);
        if (timestampOrder) {
          const anchor = this.db
            .prepare('SELECT timestamp,sequence FROM events WHERE sequence=?')
            .get(Number(q[key])) as { timestamp: string; sequence: number } | undefined;
          if (!anchor)
            throw new ApiError(
              400,
              `The ${key} cursor is unknown or has expired; refresh the timeline`,
            );
          clauses.push(`(timestamp,sequence) ${op} (?,?)`);
          values.push(anchor.timestamp, anchor.sequence);
        } else where(`sequence ${op} ?`, Number(q[key]));
      }
    for (const term of terms) where("body LIKE ? ESCAPE '\\'", `%${like(term)}%`);
    const condition = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = q.limit === undefined ? Math.min(100, maxLimit) : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit)
      throw new ApiError(400, `limit must be between 1 and ${maxLimit}`);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM events${condition}`).get(...values) as {
        n: number;
      }
    ).n;
    const order = timestampOrder
      ? 'timestamp DESC,sequence DESC'
      : `sequence ${ascending ? 'ASC' : 'DESC'}`;
    const rows = this.db
      .prepare(`SELECT sequence,body,group_id FROM events${condition} ORDER BY ${order} LIMIT ?`)
      .all(...values, limit) as Row[];
    const events = rows.map(eventFromRow);
    return {
      events,
      total,
      nextCursor: total > events.length ? events.at(-1)?.sequence : undefined,
    };
  }
  context(id: string): EventContext {
    const event = this.event(id);
    if (!event) throw new ApiError(404, 'Event not found');
    const rows = this.db
      .prepare(
        'SELECT sequence,body,group_id FROM events WHERE group_id=? ORDER BY ABS(julianday(timestamp)-julianday(?)), ABS(sequence-?) LIMIT 1000',
      )
      .all(event.groupId, event.timestamp, event.sequence) as Row[];
    const events = rows
      .map(eventFromRow)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence);
    const reasons = [
      ...new Set(
        (
          this.db
            .prepare('SELECT reasons FROM correlations WHERE group_id=? LIMIT 1000')
            .all(event.groupId) as { reasons: string }[]
        ).flatMap((row) => JSON.parse(row.reasons) as string[]),
      ),
    ];
    const precursor = [...events]
      .reverse()
      .find(
        (e) =>
          Date.parse(e.timestamp) <= Date.parse(event.timestamp) &&
          e.id !== id &&
          (e.type.startsWith('environment.') ||
            ['error', 'critical', 'warning'].includes(e.severity)),
      );
    const subject = event.project?.name ?? event.project?.id ?? event.source.app;
    const preceding = events.filter(
      (e) => e.id !== id && Date.parse(e.timestamp) <= Date.parse(event.timestamp),
    );
    const missingConfiguration = [...preceding]
      .reverse()
      .find((e) => e.type === 'environment.missing_variable');
    const portConflict = [...preceding].reverse().find((e) => e.type === 'port.conflict_detected');
    const errorSignal = [...preceding]
      .reverse()
      .find((e) => e.type.startsWith('http.') && ['error', 'critical'].includes(e.severity));
    const failed =
      ['error', 'critical'].includes(event.severity) || /\.(failed|exited)$/.test(event.type);
    const likelySignal = failed ? (missingConfiguration ?? portConflict) : undefined;
    const elapsed = (signal: StoredEvent) => {
      const seconds = Math.max(
        0,
        Math.round((Date.parse(event.timestamp) - Date.parse(signal.timestamp)) / 1000),
      );
      return `${seconds} second${seconds === 1 ? '' : 's'}`;
    };
    const summary = likelySignal
      ? `${subject}: ${likelySignal.message} is a likely contributor to the failure. It was recorded ${elapsed(likelySignal)} earlier. ${errorSignal ? `${errorSignal.message} occurred ${elapsed(errorSignal)} before the selected event. ` : ''}${event.message}. This is a hypothesis based on correlated activity, not a proven root cause.`
      : precursor
        ? `${subject}: ${event.message}. A preceding signal was “${precursor.message}” from ${precursor.source.app}, ${Math.max(0, Math.round((Date.parse(event.timestamp) - Date.parse(precursor.timestamp)) / 1000))} seconds earlier. These events are correlated; this does not establish causation.`
        : `${subject}: ${event.message}. ${events.length} related event${events.length === 1 ? '' : 's'} from ${new Set(events.map((e) => e.source.app)).size} application${new Set(events.map((e) => e.source.app)).size === 1 ? '' : 's'}. ${events.length === 1 ? 'No earlier related signal has been recorded.' : 'Inspect the sequence for possible contributing factors.'}`;
    return {
      groupId: event.groupId!,
      events,
      summary,
      reasons: reasons.length ? reasons : ['No matching correlation signals recorded'],
    };
  }
  projectStats(id: string, isConnected: (id: string) => boolean) {
    const p = this.project(id);
    if (!p) throw new ApiError(404, 'Project not found');
    const all = this.query({ project: p.id, limit: 10000 }, false, 10000).events;
    // Registry process associations are identities, not evidence that a PID is live.
    const running = new Set<number>(),
      ports = new Set<number>();
    const warnings = new Map<string, StoredEvent>();
    for (const e of [...all].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence,
    )) {
      const pid = Number(e.data.pid),
        port = Number(e.data.port);
      if (Number.isInteger(pid) && pid > 0) {
        if (/process\.(started|detected|restarted)/.test(e.type)) running.add(pid);
        if (/process\.(stopped|exited|killed)/.test(e.type)) running.delete(pid);
      }
      if (Number.isInteger(port) && port > 0) {
        if (/port\.(opened|listening)|process\.started/.test(e.type)) ports.add(port);
        if (/port\.closed|process\.(stopped|exited|killed)/.test(e.type)) ports.delete(port);
      }
      if (e.type.startsWith('environment.')) {
        const key = `${e.source.app}:${String(e.data.variable ?? e.data.key ?? e.type)}`;
        const cleanScan =
          e.type === 'environment.scan.completed' && e.data.missing === 0 && e.data.exposed === 0;
        if (
          cleanScan ||
          (/resolved|validated/.test(e.type) &&
            !['warning', 'error', 'critical'].includes(e.severity))
        ) {
          for (const [warningKey, warning] of warnings)
            if (warning.source.app === e.source.app) warnings.delete(warningKey);
        } else if (['warning', 'error', 'critical'].includes(e.severity)) {
          // A scan summary must not double-count its granular variable warnings.
          if (
            e.type !== 'environment.scan.completed' ||
            ![...warnings.values()].some((w) => w.source.app === e.source.app)
          )
            warnings.set(key, e);
        }
      }
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const errorsToday = all.filter(
      (e) =>
        ['error', 'critical'].includes(e.severity) && Date.parse(e.timestamp) >= today.getTime(),
    ).length;
    return {
      project: p,
      events: all.slice(0, 100),
      stats: {
        status: errorsToday ? 'error' : warnings.size ? 'warning' : 'healthy',
        runningProcesses: running.size,
        ports: [...ports].sort((a, b) => a - b),
        lastCommand: all.find((e) => e.data.command)?.data.command ?? null,
        lastDeployment: all.find((e) => e.type.startsWith('deploy.'))?.timestamp ?? null,
        environmentWarnings: warnings.size,
        errorsToday,
        connectedTools: [...new Set([...p.applications, ...all.map((e) => e.source.app)])].filter(
          isConnected,
        ),
      },
    };
  }
  retention(): RetentionPolicy {
    const row = this.db.prepare("SELECT body FROM settings WHERE key='retention'").get() as
      { body: string } | undefined;
    return row ? parse<RetentionPolicy>(row) : { ...DEFAULT_RETENTION };
  }
  setRetention(input: unknown): RetentionPolicy {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ApiError(400, 'retention must be an object');
    const policy = this.retention();
    for (const [key, value] of Object.entries(input)) {
      if (
        !Object.hasOwn(DEFAULT_RETENTION, key) ||
        (value !== null && (!Number.isInteger(value) || value < 1 || value > 36500))
      )
        throw new ApiError(
          400,
          'Retention values must be null (forever) or whole days from 1 to 36500',
        );
      policy[key as keyof RetentionPolicy] = value;
    }
    this.db
      .prepare(
        "INSERT INTO settings(key,body) VALUES('retention',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
      )
      .run(JSON.stringify(policy));
    return policy;
  }
  cleanup(now = Date.now()): number {
    return this.db.transaction(() => {
      let deleted = 0;
      for (const [severity, days] of Object.entries(this.retention()))
        if (days !== null)
          deleted += this.db
            .prepare('DELETE FROM events WHERE severity=? AND julianday(timestamp)<julianday(?)')
            .run(severity, new Date(now - days * 86400000).toISOString()).changes;
      return deleted;
    })();
  }
  incident(id: string): Incident | undefined {
    const row = this.db.prepare('SELECT body FROM incidents WHERE id=?').get(id) as
      { body: string } | undefined;
    return row && parse<Incident>(row);
  }
  incidents(): Incident[] {
    return (
      this.db.prepare('SELECT body FROM incidents ORDER BY rowid DESC').all() as { body: string }[]
    ).map(parse<Incident>);
  }
  createIncident(eventId: string, title?: string): Incident {
    const c = this.context(eventId),
      e = this.event(eventId)!;
    const incident: Incident = redact({
      id: randomUUID(),
      title: title || `${e.project?.name ?? e.source.app}: ${e.message.slice(0, 120)}`,
      projectId: e.project?.id,
      status: 'open',
      startedAt: c.events[0].timestamp,
      eventIds: c.events.map((e) => e.id),
      summary: c.summary,
      sources: [...new Set(c.events.map((e) => e.source.app))],
    });
    this.saveIncident(incident);
    return incident;
  }
  saveIncident(incident: Incident) {
    this.db
      .prepare(
        'INSERT INTO incidents(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(incident.id, JSON.stringify(redact(incident)));
  }
  command(id: string): CommandRecord | undefined {
    const row = this.db.prepare('SELECT body FROM commands WHERE id=?').get(id) as
      { body: string } | undefined;
    return row && parse<CommandRecord>(row);
  }
  saveCommand(command: CommandRecord) {
    this.db
      .prepare(
        'INSERT INTO commands(id,status,expires_at,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body',
      )
      .run(command.id, command.status, command.expiresAt, JSON.stringify(redact(command)));
  }
  expiredCommands(now = Date.now()): CommandRecord[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM commands WHERE status IN ('pending','accepted') AND expires_at<=?",
        )
        .all(new Date(now).toISOString()) as { body: string }[]
    ).map(parse<CommandRecord>);
  }
}
