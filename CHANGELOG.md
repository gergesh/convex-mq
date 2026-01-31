# Changelog

## 0.2.0

Library mode — use ConvexMQ with your own schema tables.

- **Library mode** (`convex-mq/table`) — define queue tables in your own schema with `messageQueueTable()`, enabling custom indexes and filtered consumption
- **Filtered consumption** — `api()` accepts a `filterConfig` to generate peek/claim functions that use custom indexes (e.g., consume only tasks for a specific worker)
- **`modulePath` defaults to table name** — no longer required in most setups; override only if your file name differs from the table name
- **`consume()` options simplified** — filter args and options merged into a single object (e.g., `consume(client, fns, handler, { worker: "w1", batchSize: 5 })`)
- **`messageQueueTable()`** — schema helper that adds system fields (`status`, `attempts`, `maxAttempts`, `visibilityTimeoutMs`, `claimId`) and a default `by_status` index
- Library mode claimed messages use `data` (not `payload`) since fields are top-level

## 0.1.0

Initial release.

- Typed message queue component for Convex
- `MessageQueue<V>` class with `api()` helper — generates all Convex function exports in one line
- Publish and claim messages in batches
- Visibility timeouts with automatic return-to-pending
- Lease tokens (`claimId`) prevent stale consumers from acking reclaimed messages
- Configurable retry attempts with dead-letter handling via `nack` return value
- `consume()` — reactive consumer using `ConvexClient` WebSocket subscriptions
- `consumePolling()` — polling-based consumer for `ConvexHttpClient`
