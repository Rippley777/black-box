import { createDaemon } from './index.js';
import { SqlSnapshot } from './sql-snapshot.js';
import type { Store } from './store.js';

let cloud: SqlSnapshot | undefined;
let store: Store | undefined;
let persist: (() => Promise<void>) | undefined;
if (process.env.BLACKBOX_SQL_SERVER) {
  cloud = new SqlSnapshot();
  store = await cloud.restore();
  let savedChanges = (store.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
  persist = async () => {
    const changes = (store!.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
    if (changes === savedChanges) return cloud!.flush();
    await cloud!.persist(store!);
    savedChanges = Math.max(savedChanges, changes);
  };
}
const daemon = createDaemon({ store, persist });
try {
  const url = await daemon.listen();
  console.log(`BLACK BOX · flight recorder\nDashboard & API: ${url}\nRemote sync: disabled`);
} catch (error) {
  console.error(
    `Black Box could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  await daemon.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void daemon.close().then(() => {
      process.exitCode = 0;
    });
  });
