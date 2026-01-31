# Changelog

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
