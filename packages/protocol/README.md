# @rippley/blackbox-protocol

Shared Rippley Event Protocol v1.0. Exports TypeScript contracts, Zod validation, wildcard matching, identity normalization, and best-effort secret redaction. Has no dependency on the daemon, database, or another Rippley application.

```ts
import { eventSchema, redact, matchesPattern } from '@rippley/blackbox-protocol';

const safeEvent = eventSchema.parse(redact(incomingEvent));
if (matchesPattern(safeEvent.type, 'process.*')) {
  // Handle a process fact.
}
```

Redact before persistence, broadcasting, or buffering. Do not include secrets in envelope identifiers. Adding new event namespaces does not require changing this package; incompatible envelope changes require a new supported schema version.
