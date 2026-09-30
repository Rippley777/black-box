# BLACK BOX

**The flight recorder for Rippley Labs.** An event bus, project timeline, and correlation engine that makes independent developer tools more useful together.

Black Box records structured events in SQLite, streams them to subscribers, and routes explicit commands to registered applications. Apps share the Rippley Event Protocol; they never import one another. The daemon does not run shell commands or upload telemetry.

## Run locally

Requires Node.js 20.15+ and npm. SQLite uses `better-sqlite3`; platforms without a prebuilt binary need their normal native build tools.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:47822**. The daemon listens on **http://127.0.0.1:47821**. The dashboard starts with an empty recorder; its data comes from the daemon, not fixtures.

For a built application with the dashboard served by the daemon:

```sh
npm run build
npm start
# Open http://127.0.0.1:47821
```

Run only the recorder with `npm run daemon`. Set `BLACKBOX_DB` to choose a database file, `BLACKBOX_PORT` to change the daemon port, and `BLACKBOX_DASHBOARD_PORT` for the development UI port. SDK clients use `BLACKBOX_URL` or an explicit endpoint to override discovery. Keep the daemon bound to loopback.

The default database is `~/Library/Application Support/black-box/black-box.db` on macOS, `$XDG_DATA_HOME/black-box/black-box.db` (or `~/.local/share/black-box/black-box.db`) on Linux, and `%LOCALAPPDATA%/black-box/black-box.db` on Windows.

## Record real activity

With Black Box running:

```sh
npm run example
```

The executable ecosystem example connects three SDK adapters, registers a project and capabilities, runs a local child process, observes a local port, checks environment variable names, and emits the resulting events. See [integration documentation](docs/integration.md) and the adapters in [examples](examples). They accept real host application handlers and are ready to move into the existing repositories; installing Black Box does not modify those repositories.

Pipe a command's output or attach a file:

```sh
your-command 2>&1 | npm run logs -- --app pit-boss --project save-scum
npm run logs -- --app my-app --file ./app.log
npm run logs -- --app my-app --file ./app.log --follow
```

The dashboard's **Attach logs** flow also accepts pasted text and uploaded files. Text lines and JSON logs are normalized into protocol events. The CLI follows appends, truncation, and replacement and keeps a bounded, redacted queue while the daemon is unavailable.

## SDK

```ts
import { createBlackBoxClient } from '@rippley/blackbox-sdk';

const blackbox = createBlackBoxClient({
  app: 'port-authority',
  version: '1.4.2',
});

await blackbox.emit('port.opened', {
  project: { id: 'save-scum', path: '/Code/save-scum' },
  message: 'Development port opened',
  data: { port: 5173, pid: 22141 },
});

const unsubscribe = blackbox.subscribe('deploy.*', (event) => {
  console.log(event.type, event.project?.id);
});
```

The SDK fails open when the recorder is unavailable, redacts before buffering, bounds memory, reconnects, and re-registers capabilities. Subscriptions use sequence cursors to resume recorded events. Call `close()` when the host application exits. Command handlers are registered by the owning app; Black Box routes requests and records acknowledgements and outcomes.

## Workbench

- **Timeline:** live recording, expandable payloads, source/project/severity filters, structured search, and historical events.
- **What the hell happened?:** reconstruct preceding activity using explicit correlations and project/process/port/command/deployment evidence. Explanations are deterministic hypotheses with supporting events, not AI diagnoses.
- **Projects:** stable identities with explicit aliases, repository and local paths; current process/port activity and unified history.
- **Applications:** registrations, versions, capabilities, subscriptions, heartbeat health, and disconnection state.
- **Incidents:** save correlated activity and mark investigations resolved.
- **Actions:** route suggested actions to a connected provider; confirmation-required actions require an explicit user step.
- **Storage:** severity-specific retention, manual cleanup, and redacted JSONL export.
- **Keyboard:** command palette, timeline search, and keyboard-accessible event controls.

Search examples:

```text
project:save-scum severity:error
source:pit-boss type:deploy.*
port:5173
pid:22141
repo:Rippley777/save-scum
tag:dev
```

## Packages and architecture

```text
packages/protocol   Versioned schema, shared contracts, redaction, pattern matching
packages/sdk        Fail-open client and replaceable HTTP/WebSocket transport
apps/daemon        HTTP API, live bus, SQLite, registries, correlation, routing
apps/dashboard     React mission-control interface
examples           Executable integration adapters
scripts            Development runner and stdin/file log ingestion
```

Build the two shared packages with `npm run build:packages`. They contain ESM output and TypeScript declarations and can be packed with `npm pack -w @rippley/blackbox-protocol` and `npm pack -w @rippley/blackbox-sdk`. Install both tarballs in the consuming repository. They are local workspace packages and have not been published to npm.

Read the [architecture](docs/architecture.md), [HTTP and stream contract](docs/CONTRACT.md), and [integration guide](docs/integration.md).

## Azure deployment

The optional cloud deployment runs on an Azure App Service F1 plan with an Azure SQL Database free-offer database. See [Azure deployment and operating notes](docs/azure.md). It requires an explicit HTTPS origin and access key. The local daemon still binds to loopback by default; SDK clients do not send events to Azure unless configured with the cloud endpoint.

## Local data and privacy

No automatic remote sync, vendor telemetry, analytics forwarding, or AI service is enabled. The optional Azure deployment stores events sent explicitly to its endpoint. The Shipwreck-facing `/ecosystem` endpoint exposes aggregate ecosystem health. House Edge remains a separate product; any future forwarding must be explicitly configured and restricted to aggregates.

Secrets in nested sensitive fields, common API key formats, bearer tokens, credential-bearing URLs, and private keys are redacted before events reach SQLite or subscribers. The SDK also redacts its offline event queue. Pattern detection cannot recognize every possible secret; emit variable **names**, never configuration values, and avoid using credentials in identifiers. Exported events have already passed through redaction.

Local mode is intended for trusted applications on a single-user machine. It rejects foreign browser origins and non-local hostnames and binds to loopback. Exact packaged Tauri origins are allowed for the existing Rippley desktop apps. Add other trusted development origins with `BLACKBOX_ALLOWED_ORIGINS`, a comma-separated list of complete origins. Cloud mode checks the configured HTTPS host and access key for every HTTP and WebSocket request. It is a single-key deployment, not a multi-user authorization system. A client with the key can publish events and request registered capabilities. Command providers should enforce their own scope and authorization; the example adapters operate only on the resources explicitly given to them.

Default event retention: debug 7 days, info/success 30 days, warning 90 days, error/critical indefinitely. Customize it in settings. Export JSONL before cleanup if you need an archive. The database remains on your machine and persists across restarts.

## Verification

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Tests cover protocol validation, redaction, storage and transport behavior, SDK failure isolation, correlation, command routing, and browser workflows. Browser tests use an isolated temporary database.

## Extension boundaries

This first version provides the local infrastructure, optional single-key Azure deployment, and operational dashboard. Unix sockets, Windows named pipes, durable disk-backed SDK buffers, multi-user authorization, optional BYOK analysis, and opt-in House Edge aggregation can be added behind the shared contracts. Event replay re-delivers historical facts; it does not rerun command handlers. UI health reflects observations received from connected apps, not an independent process supervisor.
