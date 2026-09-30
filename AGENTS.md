# Working on BLACK BOX

- Keep application integrations independent. A Rippley app imports the protocol/SDK, never another app's internals.
- `packages/protocol` is the shared contract. Coordinate schema changes across daemon, SDK, documentation, and tests. Do not silently accept incompatible schema versions.
- The daemon binds to loopback. Preserve origin/host checks, input bounds, parameterized SQL, redaction before persistence/broadcast, and command acknowledgement rules.
- SDK failures must not crash, block startup, or keep the host application alive. Bound offline queues. Explicitly awaited operations should complete normally.
- Historical replay contains facts, never executable commands. Command providers own execution and resource scope.
- The UI must use real daemon state and expose disconnected/loading/empty/error conditions. Keep example events out of production startup.
- New integrations must not enable remote telemetry, raw-log forwarding, or AI requests by default.
- Run `npm run typecheck`, `npm test`, and `npm run build` after contract/runtime changes. Use `npm run test:e2e` for affected UI workflows.
- Keep `README.md`, `docs/CONTRACT.md`, and `docs/integration.md` aligned with actual endpoints and SDK behavior.
