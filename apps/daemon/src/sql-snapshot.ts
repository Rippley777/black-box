import sql from 'mssql';
import { Store } from './store.js';

/** One SQLite writer in memory, checkpointed to an Azure SQL free database. */
export class SqlSnapshot {
  private pending: Promise<void> = Promise.resolve();
  private readonly config: sql.config;

  constructor() {
    const server = process.env.BLACKBOX_SQL_SERVER;
    const database = process.env.BLACKBOX_SQL_DATABASE;
    const user = process.env.BLACKBOX_SQL_USER;
    const password = process.env.BLACKBOX_SQL_PASSWORD;
    if (!server || !database || !user || !password)
      throw new Error('Cloud storage requires BLACKBOX_SQL_SERVER, DATABASE, USER and PASSWORD');
    this.config = {
      server,
      database,
      user,
      password,
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 90000,
      requestTimeout: 90000,
      pool: { min: 0, max: 1, idleTimeoutMillis: 1000 },
    };
  }

  private async withPool<T>(callback: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
    const pool = new sql.ConnectionPool(this.config);
    await pool.connect();
    try {
      return await callback(pool);
    } finally {
      await pool.close();
    }
  }

  async restore(): Promise<Store> {
    const image = await this.withPool(async (pool) => {
      await pool.request().query(`
        IF OBJECT_ID(N'dbo.blackbox_state', N'U') IS NULL
          CREATE TABLE dbo.blackbox_state (
            id int NOT NULL PRIMARY KEY CHECK (id = 1),
            image varbinary(max) NOT NULL,
            saved_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
          )
      `);
      const result = await pool.request().query<{ image: Buffer }>(
        'SELECT image FROM dbo.blackbox_state WHERE id = 1',
      );
      return result.recordset[0]?.image;
    });
    return new Store(image ?? ':memory:');
  }

  persist(store: Store): Promise<void> {
    // Take the image now so each acknowledged write has a durable checkpoint.
    const image = store.db.serialize();
    this.pending = this.pending.catch(() => {}).then(() =>
      this.withPool(async (pool) => {
        await pool.request().input('image', sql.VarBinary(sql.MAX), image).query(`
          UPDATE dbo.blackbox_state SET image = @image, saved_at = SYSUTCDATETIME() WHERE id = 1;
          IF @@ROWCOUNT = 0
            INSERT INTO dbo.blackbox_state (id, image) VALUES (1, @image);
        `);
      }),
    );
    return this.pending;
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
