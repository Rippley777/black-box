# Integrating a Rippley Labs application

Black Box is optional infrastructure. An application imports only the event protocol and SDK; it never imports another application's implementation. Publishing starts immediately, and a missing daemon does not reject promises or crash the host.

## Install and emit

The packages are ready to build and pack, but have not been published to npm. From this checkout:

```sh
npm install
npm run build:packages
npm pack --workspace @rippley/blackbox-protocol
npm pack --workspace @rippley/blackbox-sdk
```

Install both resulting tarballs in the host repository, or use a workspace containing both packages. Package exports point to compiled ESM JavaScript and TypeScript declarations. Node 20.15+ and browser/Tauri webviews are supported; Node uses `ws` and browsers use their native WebSocket implementation.

```ts
import { createBlackBoxClient } from '@rippley/blackbox-sdk';

const blackbox = createBlackBoxClient({
  app: 'port-authority',
  name: 'Port Authority',
  version: APP_VERSION,
});

await blackbox.emit('port.opened', {
  project: { id: 'save-scum', path: '/Code/save-scum' },
  message: 'Development server is listening',
  port: 5173,
  pid: 22141,
});
```

The default endpoint is `http://127.0.0.1:47821`. An explicit `endpoint` takes precedence over `BLACKBOX_URL` in Node. Browser integrations supply `endpoint` when necessary and must permit the local HTTP/WebSocket destination in their CSP. The daemon must allow the webview's origin; keep the allowlist explicit instead of enabling arbitrary websites. No discovery broadcast, remote telemetry, or external service is used.

For the optional Azure instance, set `endpoint` and `accessToken` explicitly on `createHttpTransport`; see [Azure deployment](azure.md). Node can also read `BLACKBOX_URL` and `BLACKBOX_ACCESS_TOKEN` from its environment. The access key authorizes both ingestion and commands, so keep it outside browser bundles. The default local endpoint is unchanged.

`emit(type, details)` extracts `message`, `severity`, `project`, `correlationId`, `parentEventId`, `tags`, `metadata`, and `actions` into the event envelope. Additional fields become `data`. `publish(event)` accepts the explicit protocol shape, fills IDs/timestamps/source/schema version, validates, and redacts it. Preserve an event's ID when retrying manually: the daemon deduplicates it.

## Delivery and failure behavior

- `emit` and `publish` resolve `true` when an event is accepted into the queue. This is not a persistence acknowledgement. They resolve `false` for invalid input, oversized events, or a closed client.
- Default buffering is **500 events, 2 MiB, 5 minutes** in memory. The oldest entry is evicted when full. Secrets are redacted before buffering. Process exit or `close()` discards remaining events; this is not a durable outbox.
- Configure `queueLimit`, `queueMaxBytes`, and `queueTtlMs` for the host's workload. Each event is capped at 1 MiB after redaction/serialization; larger events are rejected and counted as dropped. `queueLimit: 0` performs one best-effort HTTP delivery and retains nothing on failure.
- `flush()` attempts delivery in batches of at most 100 events below the daemon's 2 MiB request limit and returns the number sent. HTTP 413 responses cause smaller batches; a single event still rejected as too large is dropped with a diagnostic so subsequent events can proceed. A failed batch stays queued, expires normally, and retries with exponential backoff from 500 ms to 30 seconds.
- Heartbeats default to 15 seconds. Applications, capabilities, actions, and known projects are registered again after reconnection. A daemon restart using its existing database preserves sequence cursors.
- Subscriber exceptions, rejected async callbacks, provider failures, transport failures, and errors in `onError` are isolated. `onError` receives a redacted error; `client.stats` exposes connectivity, queue size/bytes, dropped count, and the last error.
- Node background timers and open stream sockets do not keep the host alive. An explicitly awaited `request` uses a referenced polling timer until completion. Call `await client.flush(); client.close()` during an existing graceful shutdown path; do not keep an app alive solely to deliver telemetry.
- Commands are never queued or automatically resubmitted. An unavailable daemon/provider returns `undefined` with details in `stats.lastError`. `query` returns an empty result when unavailable; use `stats.lastError` to distinguish unavailable from empty.

```ts
const blackbox = createBlackBoxClient({
  app: 'pit-boss',
  queueLimit: 1_000,
  queueMaxBytes: 4 * 1024 * 1024,
  queueTtlMs: 60_000,
  onError: (error) => diagnostics.record('blackbox', error.message),
});
```

## Shared project identity

Choose one stable project ID, and register the full aliases explicitly. Do not derive identity from a directory basename alone: two unrelated repositories can have the same name.

```ts
await blackbox.identifyProject({
  id: 'save-scum',
  name: 'Save Scum',
  paths: ['/Code/save-scum'],
  repo: 'Rippley777/save-scum',
  remoteUrl: 'https://github.com/Rippley777/save-scum.git',
  aliases: ['Save Scum', 'save-scum'],
  domains: ['save-scum.local'],
  environments: ['development'],
  commands: ['npm run dev'],
  applications: ['pit-boss', 'port-authority'],
});
```

Events can identify that project by registered path, repository, name, or ID. Cross-tool workflows should pass a shared `correlationId`; command handlers receive the router's ID so their follow-up events can use it. `parentEventId` expresses a direct causal link when known. Temporal proximity alone is correlation, not proof of cause.

## Subscribe and query

```ts
const unsubscribe = blackbox.subscribe('process.*', async (event) => {
  await refreshProjectStatus(event.project);
});
const history = await blackbox.query({
  project: 'save-scum',
  type: 'deploy.*',
  severity: 'error',
  limit: 100,
});
unsubscribe();
```

A new client starts replay at sequence zero. Subsequent reconnects request events after the last received sequence. The SDK keeps a bounded 2,000-ID deduplication window. Subscribers should still be idempotent, particularly across application restarts; the cursor is in memory, not persisted. Replay only delivers events and never reexecutes a command. Adding a subscription uses the client's current shared cursor, rather than requesting a new historical scan for that pattern; use `query` for that scan.

## Capabilities, commands, and actions

Register a capability only when its real handler is available. The daemon owns routing and acknowledgements; the provider owns validation, authorization, process identity checks, and actual execution. A capability name is not a shell command.

```ts
await blackbox.registerCapability(
  {
    name: 'project.restart',
    requiresConfirmation: true,
    description: 'Restart a saved project through Pit Boss',
  },
  async (payload, command) => {
    const projectId = requireKnownProjectId(payload.projectId);
    const result = await restartSavedProject(projectId); // existing application API
    await blackbox.emit('process.restarted', {
      project: { id: projectId },
      correlationId: command.correlationId,
      message: 'Project restarted through Pit Boss',
    });
    return { runId: result.id };
  },
);
```

An application must be registered and have a live stream before the daemon routes to it. `client.stats.connected` reflects the stream connection. Registered providers survive offline registration and reappear when the daemon returns. The SDK acknowledges `accepted` before invoking the handler and then `completed` or `failed`; a failed acceptance acknowledgement prevents execution. Duplicate command IDs are ignored within a bounded in-memory window. A timeout is not cancellation: a provider operation already accepted may still finish. Check cancellation and deadlines in the host when appropriate.

```ts
// Only set confirmed after the host UI collected the required confirmation.
const result = await blackbox.request({
  provider: 'pit-boss',
  command: 'project.restart',
  payload: { projectId: 'save-scum' },
  confirmed: true,
  timeoutMs: 15_000,
});
// result?.status: completed | failed | timeout (undefined if unavailable)
```

Omit `provider` to resolve a uniquely registered capability. Ambiguous providers are rejected. `request('port.inspect', { port: 5173 })` is shorthand; `execute(input)` is an alias. `command(input)` returns the initial command without waiting, and `getCommand(id)` polls explicitly. Do not retry a command after an uncertain network response without checking its state first.

```ts
const action = {
  id: 'restart-save-scum',
  label: 'Restart project',
  provider: 'pit-boss',
  command: 'project.restart',
  payload: { projectId: 'save-scum' },
  requiresConfirmation: true,
};
await blackbox.registerAction(action);
await blackbox.emit('deploy.failed', {
  severity: 'error',
  message: 'Deployment failed',
  project: { id: 'save-scum' },
  actions: [action],
});
```

Action metadata is a suggestion for the UI; the registered capability also enforces confirmation. Never take executable command strings, arbitrary paths, or PIDs from events and feed them directly to a shell. Use project/preset IDs resolved by the host's own registry.

## Logs

```ts
await blackbox.ingestLogs(lines, {
  stream: 'stderr',
  project: { id: 'save-scum' },
  correlationId: run.id,
});
```

The SDK normalizes each line into `log.stdout`, `log.stderr`, or `log.file`. JSON `message`/`msg` and `level`/`severity` are recognized; structured fields are preserved after redaction. Plain stderr defaults to error. SDK log events use the same idempotent offline queue as structured events. Pass complete lines or buffer chunk boundaries in the host. The daemon also exposes `POST /logs` for non-SDK senders and `npm run logs` for files or stdin.

Redaction is best effort. The adapters omit environment values, definitions, fingerprints, and complete host configuration entirely; extend that rule to any sensitive fields in future integrations.

## Concrete adapters and existing hook points

The adapters in `examples/` are executable TypeScript integration modules with injected host handlers. They do not import sibling repositories and have not been installed in those applications. Their structural types were checked against the adjacent applications in this workspace.

| Application    | Adapter                      | Existing host hook                                                                                                                                                                                                                                 |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port Authority | `examples/port-authority.ts` | After a successful native `scanPorts()` in `src/lib/api.ts`, pass actual `PortEntry[]` to `observePorts`. The fields match `src/lib/types.ts`, including `project.rootPath` and repository metadata.                                               |
| Pit Boss       | `examples/pit-boss.ts`       | In the native `api.subscribe` / `run-update` listener in `src/bridge.ts` and `src/App.tsx`, call `recordRun` on status transitions, and pass only new output lines to `output`. `ObservedRun` matches the corresponding fields in `src/types.ts`.  |
| Env Reaper     | `examples/env-reaper.ts`     | Pass real results after `acceptScan(result)` in `src/App.tsx` (`runScan`) to `recordScan`. Inject the existing `scan_project` or `scanInWorker` path through `validate`. The adapter's scan fields match `src/lib/types.ts` and skip `demo: true`. |

Port Authority's injected process handlers should resolve the **fresh** entry and call its existing `controlProcess(entry, action)` API, which preserves protected-process and `(pid, startedAt)` checks. The adapter only permits observed, unprotected PIDs; the host must recheck them to prevent PID-reuse mistakes. A lost listening port does not prove process exit: `observePorts` emits port closures, while `processStopped` is a separate hook for confirmed exits.

Pit Boss should resolve IDs through its stored projects and presets, then reuse `api.run(projectId, presetId, confirmation)` / `api.stop(runId)`. Preserve the host's confirmation flow and never bypass its existing production/dangerous-command checks. Pass only actual desktop runs; its browser demo bridge intentionally simulates runs and should not feed production telemetry. Register run/deploy/restart handlers only when these operations are implemented.

Env Reaper's provider returns counts and variable names/statuses, never source-file content or values. Keep its existing project selection and scanner protections. Do not send the demo scanner's fixtures into Black Box.

### Run the real local exercise

```sh
# Terminal 1
npm run daemon
# Terminal 2
npm run example
```

`examples/ecosystem.ts` creates a real child Node TCP listener on an ephemeral loopback port, observes its actual PID/port, captures its real stdout, probes it using `node:net`, checks whether `PATH` and `BLACKBOX_SAMPLE_REQUIRED` are present without reading values into telemetry, routes `port.inspect` and `environment.validate` through Black Box, and stops only its own child. It records a shared sandbox project and correlation ID. It makes no HTTP-500 or deployment-failure claims that did not occur. The sample uses `*-example` application IDs so it cannot impersonate installed host applications or control their processes. Stop/kill capabilities reject every process/project outside the sample.

The missing sample environment name is a real presence check: set `BLACKBOX_SAMPLE_REQUIRED` before starting the example to see a healthy result. This variable is only a sandbox requirement, not a Black Box configuration requirement.

## Alternate transport

Implement the exported `BlackBoxTransport` interface with `request(method, path, body?)` and `connect({ appId, patterns, since }, callbacks)`. Return an object with `close()` from `connect`; call `open`, `message`, `close`, and `error` for transport lifecycle events. Optional transport-level `close()` aborts outstanding work. The HTTP API contract is in `docs/CONTRACT.md` and the event/command types are in `@rippley/blackbox-protocol`.

Custom transports must enforce their own request deadlines and honor close; otherwise an unresolved transport promise can delay SDK progress. Preserve event IDs, ordered sequence replay, and acknowledgement semantics when adding Unix sockets or Windows named pipes. The SDK handles queueing and callback isolation above the transport layer.
