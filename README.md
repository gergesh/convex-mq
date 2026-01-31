# ConvexMQ

A typed message queue [component](https://docs.convex.dev/components) for [Convex](https://convex.dev). Publish messages from your Convex mutations, consume them from any external service — reactively via WebSocket or by polling.

- **Typed payloads** — define your message schema once, get type safety everywhere
- **Reactive consumption** — subscribe to new messages in real-time, no polling needed
- **Visibility timeouts** — claimed messages auto-return to the queue if not acked
- **Lease tokens** — prevents stale consumers from acking messages they no longer own
- **Automatic retries** — configurable max attempts with dead-letter handling
- **Batch operations** — publish and claim messages in batches
- **Zero boilerplate** — `api()` generates all your Convex function exports in one line

## Installation

```bash
npm install convex-mq
```

## Setup

### 1. Add the component to your Convex app

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import messageQueue from "convex-mq/convex.config";

const app = defineApp();
app.use(messageQueue, { name: "emailQueue" });
export default app;
```

Each queue instance gets an isolated table. For multiple message types, add multiple instances:

```ts
app.use(messageQueue, { name: "emailQueue" });
app.use(messageQueue, { name: "taskQueue" });
```

### 2. Define your queue

```ts
// convex/emailQueue.ts
import { MessageQueue } from "convex-mq";
import { components } from "./_generated/api";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const emailQueue = new MessageQueue(components.emailQueue, {
  message: v.object({
    to: v.string(),
    subject: v.string(),
    body: v.string(),
  }),
  defaultMaxAttempts: 3, // optional, default: 3
  defaultVisibilityTimeoutMs: 30_000, // optional, default: 30s
});

// Generates typed peek/claim/ack/nack/publish/publishBatch exports
export const { peek, claim, ack, nack, publish, publishBatch } = emailQueue.api(query, mutation);
```

That's it. No boilerplate wrappers needed.

### Authentication

By default, `api()` generates public functions. In production, you'll typically want:

- **Publishing** — requires user authentication (only logged-in users can enqueue messages)
- **Consuming** — requires a [deploy key](https://docs.convex.dev/production/deploy-keys) (only your server-side consumers can claim/ack messages)

Convex has built-in support for this via [`internalQuery`/`internalMutation`](https://docs.convex.dev/functions/internal-functions), which can only be called from other Convex functions or with a deploy key:

```ts
// convex/emailQueue.ts
import { MessageQueue } from "convex-mq";
import { components } from "./_generated/api";
import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

const emailQueue = new MessageQueue(components.emailQueue, {
  message: v.object({ to: v.string(), subject: v.string(), body: v.string() }),
});

// Consumer ops — deploy key only (internal functions)
export const { peek, claim, ack, nack } = emailQueue.api(internalQuery, internalMutation);
```

For publishing, use [custom function builders](https://docs.convex.dev/auth/custom-functions) from `convex-helpers` to require user auth:

```ts
// convex/auth.ts
import { customMutation } from "convex-helpers/server/customFunctions";
import { mutation } from "./_generated/server";

export const authenticatedMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return { ctx: { userId: identity.subject }, args: {} };
  },
});
```

```ts
// convex/emailQueue.ts (continued)
import { authenticatedMutation } from "./auth";

// Publishing — user auth required
export const publish = authenticatedMutation({
  args: { to: v.string(), subject: v.string(), body: v.string() },
  handler: async (ctx, args) => emailQueue.publish(ctx, args),
});
```

Server-side consumers connect with a deploy key using `setAdminAuth`:

```ts
// ConvexHttpClient
const http = new ConvexHttpClient(CONVEX_URL);
(http as any).setAdminAuth(process.env.CONVEX_DEPLOY_KEY!);

// ConvexClient (WebSocket)
const ws = new ConvexClient(CONVEX_URL);
(ws as any).setAdminAuth(process.env.CONVEX_DEPLOY_KEY!);
```

> **Note:** `setAdminAuth` exists on both clients but is not in the published type
> definitions — the `as any` cast is needed. Do not use `setAuth` for deploy keys;
> that method is for user JWT tokens.

See [`examples/authenticated-queue.ts`](examples/authenticated-queue.ts) for a complete setup.

### 3. Publish messages

From any Convex mutation:

```ts
// From a Convex mutation in your app
await ctx.runMutation(api.emailQueue.publish, {
  to: "alice@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
});
```

Or publish a batch:

```ts
await ctx.runMutation(api.emailQueue.publishBatch, {
  messages: [
    { to: "alice@example.com", subject: "Hello", body: "..." },
    { to: "bob@example.com", subject: "Hello", body: "..." },
  ],
});
```

## Consuming Messages

### Reactive consumer (recommended)

Uses a WebSocket subscription — processes messages as soon as they're published:

```ts
import { ConvexClient } from "convex/browser";
import { consume } from "convex-mq/client";
import { api } from "../convex/_generated/api.js";

const client = new ConvexClient(process.env.CONVEX_URL!);

const stop = consume(client, api.emailQueue, async (messages) => {
  for (const msg of messages) {
    await sendEmail(msg.payload.to, msg.payload.subject, msg.payload.body);
  }
});

// Graceful shutdown
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
```

### Polling consumer

For environments without WebSocket support:

```ts
import { ConvexHttpClient } from "convex/browser";
import { consumePolling } from "convex-mq/client";
import { api } from "../convex/_generated/api.js";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

const controller = consumePolling(
  client,
  api.emailQueue,
  async (messages) => {
    for (const msg of messages) {
      await sendEmail(msg.payload.to, msg.payload.subject, msg.payload.body);
    }
  },
  { pollIntervalMs: 2000 },
);

// Stop: controller.abort();
```

### Manual consumption

For full control, use the raw functions directly:

```ts
const hasPending = await client.query(api.emailQueue.peek, {});

if (hasPending) {
  const messages = await client.mutation(api.emailQueue.claim, { limit: 5 });

  for (const msg of messages) {
    try {
      await processMessage(msg.payload);
      await client.mutation(api.emailQueue.ack, {
        messageId: msg.id,
        claimId: msg.claimId,
      });
    } catch (err) {
      const result = await client.mutation(api.emailQueue.nack, {
        messageId: msg.id,
        claimId: msg.claimId,
        error: err.message,
      });

      if (result) {
        // Retries exhausted — handle dead letter
        console.error("Message failed permanently:", result.payload);
      }
    }
  }
}
```

### Filtered consumption

For workers that need to consume only specific messages (e.g., messages assigned to them), define a custom query that filters pending messages:

```ts
// convex/taskQueue.ts
import { MessageQueue } from "convex-mq";
import { components } from "./_generated/api";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const taskQueue = new MessageQueue(components.taskQueue, {
  message: v.object({
    worker: v.string(),
    task: v.string(),
    data: v.any(),
  }),
});

// Standard exports
export const { ack, nack, publish, claimByIds, listPending } = taskQueue.api(query, mutation);

// Custom filtered query — workers subscribe to this
export const getTasksForWorker = query({
  args: { worker: v.string() },
  handler: async (ctx, args) => {
    const pending = await taskQueue.listPending(ctx);
    return pending.filter((msg) => msg.payload.worker === args.worker);
  },
});
```

Then consume with `consumeFiltered`:

```ts
import { ConvexClient } from "convex/browser";
import { consumeFiltered } from "convex-mq/client";
import { api } from "../convex/_generated/api.js";

const client = new ConvexClient(process.env.CONVEX_URL!);

// Only process tasks assigned to "worker-1"
const stop = consumeFiltered(
  client,
  {
    list: api.taskQueue.getTasksForWorker,
    claimByIds: api.taskQueue.claimByIds,
    ack: api.taskQueue.ack,
    nack: api.taskQueue.nack,
  },
  { worker: "worker-1" },
  async (messages) => {
    for (const msg of messages) {
      console.log(`Processing task: ${msg.payload.task}`);
    }
  },
);
```

This pattern allows arbitrary filtering logic — filter by worker, priority, message type, or any combination. The subscription is reactive: when new matching messages appear, the consumer is notified immediately.

## How It Works

### Message lifecycle

```
publish → [pending] → claim → [claimed] → ack → (deleted)
                                    ↓
                                  nack → [pending] (retry)
                                    ↓
                              nack (exhausted) → returns payload to caller → (deleted)
```

### Visibility timeouts

When a message is claimed, a visibility timeout is scheduled. If the consumer doesn't ack or nack before the timeout fires, the message automatically returns to pending and can be claimed by another consumer.

### Lease tokens (claimId)

Each `claim` generates a unique `claimId`. The consumer must provide this token when calling `ack` or `nack`. If the visibility timeout fires and another consumer reclaims the message, the original consumer's `claimId` becomes invalid — their ack/nack will be rejected, preventing double-processing.

### Retry exhaustion

When `nack` is called and the message has reached `maxAttempts`, the message is deleted and its payload is returned to the caller as an `ExhaustedMessage`. This lets you implement dead-letter handling however you want — log it, store it in another table, send an alert, etc.

## API Reference

### `MessageQueue<V>` class

```ts
new MessageQueue(component, {
  message: v.object({ ... }),       // payload validator (required)
  defaultMaxAttempts?: number,       // default: 3
  defaultVisibilityTimeoutMs?: number, // default: 30000
})
```

#### `.api(query, mutation)`

Returns typed Convex function exports: `{ peek, claim, ack, nack, publish, publishBatch, listPending, claimByIds }`.

#### `.publish(ctx, payload)`

Publish a single message. Used inside Convex mutations.

#### `.publishBatch(ctx, payloads)`

Publish multiple messages atomically.

#### `.peek(ctx) → boolean`

Returns `true` if there are pending messages. Designed as a lightweight subscription signal.

#### `.claim(ctx, limit?) → ClaimedMessage<T>[]`

Claim up to `limit` (default 5) pending messages. Returns an array of claimed messages with `id`, `claimId`, `payload`, and `attempts`.

#### `.ack(ctx, messageId, claimId)`

Acknowledge a message — deletes it from the queue.

#### `.nack(ctx, messageId, claimId, error?) → ExhaustedMessage<T> | null`

Reject a message. Returns it to pending for retry. If retries are exhausted, deletes the message and returns `{ exhausted: true, payload, attempts, error }`.

#### `.listPending(ctx, limit?) → PendingMessage<T>[]`

List up to `limit` (default 100) pending messages. Use this to build custom filtered queries. Returns an array of pending messages with `id`, `payload`, and `attempts`.

#### `.claimByIds(ctx, messageIds) → ClaimedMessage<T>[]`

Claim specific messages by their IDs. Use after filtering messages from `listPending`. Messages that are no longer pending are silently skipped.

### `consume(client, fns, handler, options?)`

Reactive consumer using `ConvexClient` subscriptions.

- `client` — `ConvexClient` instance
- `fns` — queue module (e.g., `api.emailQueue`)
- `handler` — `async (messages: ClaimedMessage<T>[]) => void`
- `options.batchSize` — max messages per claim (default 10)

Returns a `stop()` function.

### `consumePolling(client, fns, handler, options?)`

Polling-based consumer using `ConvexHttpClient`.

- `options.batchSize` — max messages per claim (default 10)
- `options.pollIntervalMs` — polling interval (default 1000)

Returns an `AbortController`.

### `consumeFiltered(client, fns, queryArgs, handler, options?)`

Reactive consumer using a custom filtered query.

- `client` — `ConvexClient` instance
- `fns` — object with `{ list, claimByIds, ack, nack }` function references
- `queryArgs` — arguments to pass to the custom list query
- `handler` — `async (messages: ClaimedMessage<T>[]) => void`
- `options.batchSize` — max messages per claim (default 10)

Returns a `stop()` function.

### `consumeFilteredPolling(client, fns, queryArgs, handler, options?)`

Polling-based consumer with custom filtering.

- `options.batchSize` — max messages per claim (default 10)
- `options.pollIntervalMs` — polling interval (default 1000)

Returns an `AbortController`.

## License

MIT
