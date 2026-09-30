# Azure free-tier deployment

The deployed instance is `https://rippley-black-box-2027.azurewebsites.net` in resource group `rg-black-box-free` (Central US). It uses the `black-box-free-plan` Linux App Service F1 plan and `black-box` Azure SQL free-offer database on `black-box-rippley-2027-sql`. The SQL database has `useFreeLimit=true` and `freeLimitExhaustionBehavior=AutoPause`, so it pauses instead of billing for usage beyond the free monthly allowance. App Service F1 has its own CPU and connection limits and is intended for light development use; the site may sleep when idle.

The browser sign-in and remote SDK both use the access key stored in `~/.config/black-box/azure-credentials.json` (file mode 0600). Keep this file private. Azure App Service application settings hold the same key and SQL credentials; do not commit them. The login sets an HttpOnly, Secure, SameSite=Lax cookie so a browser can complete the redirect into the dashboard; API writes still require a trusted origin. `BLACKBOX_PUBLIC_ORIGIN` must be an HTTPS origin and `BLACKBOX_ACCESS_TOKEN` must have at least 32 characters before the daemon can bind beyond loopback. HTTPS-only and WebSockets are enabled on the site.

To deploy a code update from this checkout:

```sh
npm run package:azure
az webapp deploy -g rg-black-box-free -n rippley-black-box-2027 \
  --src-path /tmp/black-box-azure.zip --type zip --timeout 900000
```

The packaging command bundles the daemon and dashboard, then puts only three runtime dependencies in the archive. App Service performs the Linux `npm install`, which builds/installs the native SQLite module for that environment. The app's startup command is `npm start` on Node 22 LTS. Do not upload the macOS `node_modules` directory.

To send from a Node SDK client, explicitly opt in to the cloud endpoint:

```ts
import { createBlackBoxClient, createHttpTransport } from '@rippley/blackbox-sdk';

const blackbox = createBlackBoxClient({
  app: 'my-app',
  transport: createHttpTransport({
    endpoint: 'https://rippley-black-box-2027.azurewebsites.net',
    accessToken: process.env.BLACKBOX_ACCESS_TOKEN,
    timeoutMs: 90000, // the free SQL database may need to wake from auto-pause
  }),
});
```

Keep the access key on the server side. A browser SDK on another origin cannot put an Authorization header on the native WebSocket handshake, and the cloud site accepts only its own browser origin. Use the hosted dashboard for browser access, or a trusted server-side proxy for another web app.

Azure SQL stores a checkpointed SQLite database image. The daemon uses an in-memory SQLite writer; successful event, registration, command, incident, and setting writes wait for the SQL checkpoint. Heartbeats are soft state and checkpoint with the next durable write or graceful shutdown; command timeouts and retention cleanup checkpoint when they change stored data. This avoids keeping the free SQL database awake for every heartbeat. The single image design is suitable for a small free-tier instance, not high-throughput or multiple replicas. When the SQL free limit is exhausted and the database auto-pauses until the next month, writes return 503 and the app may fail to start after a restart. The dashboard is a development deployment with no uptime guarantee. Export redacted JSONL from the dashboard when you need a separate archive.

The SQL server firewall's `AllowAzureServices` rule permits Azure-hosted clients so the free App Service can reach the database; SQL authentication uses a generated password and encryption. Azure networking features with private endpoints are outside this free configuration.
