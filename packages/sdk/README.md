# @rippley/blackbox-sdk

An optional, fail-open TypeScript client for the BLACK BOX local recorder.

```ts
import { createBlackBoxClient } from '@rippley/blackbox-sdk';

const client = createBlackBoxClient({ app: 'my-app', version: '1.0.0' });

await client.emit('application.started', {
  message: 'Ready',
  project: { id: 'my-project' },
});

const unsubscribe = client.subscribe('deploy.*', (event) => {
  // Historical replay can deliver an event again after a reconnect.
  // Deduplicate any persistent side effects by event.id.
});

await client.registerCapability('application.inspect', () => ({ healthy: true }));
```

The default daemon address is `http://127.0.0.1:47821`. Override it with `endpoint` or `BLACKBOX_URL` in Node. The app continues working if the daemon is unavailable.

The default in-memory queue retains up to 500 redacted events, 2 MiB, and 5 minutes. `emit()` returning true means the event entered the queue; it is not a persistence acknowledgement. `flush()` attempts delivery. Set `queueLimit: 0` for immediate best-effort delivery with no offline queue. Buffers are not durable across host restarts.

Other methods: `publish`, `query`, `identifyProject`, `registerAction`, `heartbeat`, `ingestLogs`, `command`, `request`, `getCommand`, and `execute`. `client.stats` exposes connection and queue state. Failures resolve safely and can be observed through `onError`.

Capability handlers run only after an acceptance acknowledgement. Commands are not buffered or replayed. Providers must validate requested resources and retain their own execution permissions. A router timeout is not cancellation of an already-running handler.

Implement `BlackBoxTransport.request` and `connect` to replace HTTP/WebSocket with another local transport. Browser and Tauri integrations need an explicit allowed origin and appropriate CSP access to the local daemon. Node 20.15+ uses `ws`; browser clients use their native WebSocket.

During an existing host shutdown sequence, call `await client.flush(); client.close()`. Background timers and sockets do not keep Node running.
