# ConvexMQ

A typed message queue for [Convex](https://convex.dev). Publish messages from your Convex mutations, consume them from any external service — reactively via WebSocket or by polling.

- **Two modes** — component mode (isolated tables) or library mode (your schema, your indexes)
- **Typed payloads** — define your message schema once, get type safety everywhere
- **Reactive consumption** — subscribe to new messages in real-time, no polling needed
- **Visibility timeouts** — claimed messages auto-return to the queue if not acked
- **Lease tokens** — prevents stale consumers from acking messages they no longer own
- **Automatic retries** — configurable max attempts with dead-letter handling
- **Batch operations** — publish and claim messages in batches
- **Filtered consumption** — consume subsets of messages using custom indexes (library mode)
- **Zero boilerplate** — `api()` generates all your Convex function exports in one line

## Installation

```bash
npm install convex-mq
```

## Choose Your Mode

ConvexMQ offers two ways to use it:

|                          | Component Mode                    | Library Mode                     |
| ------------------------ | --------------------------------- | -------------------------------- |
| **Table ownership**      | Component owns the table          | You own the table in your schema |
| **Custom indexes**       | Not supported                     | Full index support               |
| **Filtered consumption** | Not supported                     | Filter by any indexed field      |
| **Setup**                | `app.use(messageQueue)` in config | `messageQueueTable()` in schema  |
| **Import**               | `convex-mq`                       | `convex-mq/table`                |

**Use component mode** when you want a simple, isolated queue with no custom queries.

**Use library mode** when you need custom indexes, filtered consumption, or want to query messages alongside your other data.

---

## Component Mode

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

---

## Library Mode

Library mode lets you define the queue table in your own schema, enabling custom indexes and filtered consumption.

### 1. Define the table in your schema

```ts
// convex/schema.ts
import { defineSchema } from "convex/server";
import { messageQueueTable } from "convex-mq/table";
import { v } from "convex/values";

export default defineSchema({
  tasks: messageQueueTable({
    worker: v.string(),
    task: v.string(),
    fileSize: v.number(),
  })
    .index("by_worker", ["status", "worker"])
    .index("by_size", ["status", "fileSize"]),
});
```

`messageQueueTable()` adds the system fields (`status`, `attempts`, `maxAttempts`, `visibilityTimeoutMs`, `claimId`) and a default `by_status` index. Your fields are stored at the top level, so they're indexable.

### 2. Define your queue

```ts
// convex/tasks.ts
import { MessageQueue } from "convex-mq/table";
import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

const taskQueue = new MessageQueue("tasks", {
  worker: v.string(),
  task: v.string(),
  fileSize: v.number(),
});

// Unfiltered — processes all pending messages
export const { peek, claim, ack, nack, publish, publishBatch, reclaimStale } = taskQueue.api(
  internalQuery,
  internalMutation,
);
```

The module path defaults to the table name (`"tasks"` → scheduler calls `"tasks:reclaimStale"`). If your file name differs from the table name, pass `modulePath` explicitly:

```ts
const taskQueue = new MessageQueue("tasks", { ... }, {
  modulePath: "myTasks",  // for convex/myTasks.ts
});
```

### 3. Filtered consumption

Define additional exports that consume a subset of messages using a custom index:

```ts
// convex/tasks.ts (continued)

// Filtered — consume only tasks for a specific worker
export const { peek: peekByWorker, claim: claimByWorker } = taskQueue.api(
  internalQuery,
  internalMutation,
  {
    filterArgs: { worker: v.string() },
    filter: (q, { worker }) =>
      q.withIndex("by_worker", (idx) => idx.eq("status", "pending").eq("worker", worker)),
  },
);
```

Consumers pass filter args directly in the options:

```ts
consume(client, internal.tasks, handler, { worker: "worker-1" });
```

### 4. Publish messages

```ts
// From any Convex mutation
await ctx.runMutation(internal.tasks.publish, {
  worker: "worker-1",
  task: "resize-image",
  fileSize: 1024,
});
```

In library mode, message fields are top-level args (not nested under `payload`).

---

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

---

## Authentication

By default, `api()` generates public functions. In production, you'll typically want:

- **Publishing** — requires user authentication (only logged-in users can enqueue messages)
- **Consuming** — requires a [deploy key](https://docs.convex.dev/production/deploy-keys) (only your server-side consumers can claim/ack messages)

Use [`internalQuery`/`internalMutation`](https://docs.convex.dev/functions/internal-functions) for deploy-key-only access:

```ts
export const { peek, claim, ack, nack } = emailQueue.api(internalQuery, internalMutation);
```

For publishing with user auth, use [custom function builders](https://docs.convex.dev/auth/custom-functions) from `convex-helpers`:

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
// convex/emailQueue.ts
export const publish = authenticatedMutation({
  args: { to: v.string(), subject: v.string(), body: v.string() },
  handler: async (ctx, args) => emailQueue.publish(ctx, args),
});
```

Server-side consumers connect with a deploy key using `setAdminAuth`:

```ts
const client = new ConvexClient(CONVEX_URL);
(client as any).setAdminAuth(process.env.CONVEX_DEPLOY_KEY!);
```

> **Note:** `setAdminAuth` exists on both `ConvexClient` and `ConvexHttpClient` but is not in the published type definitions — the `as any` cast is needed.

---

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

---

## API Reference

### Component Mode — `MessageQueue` (from `convex-mq`)

```ts
new MessageQueue(component, {
  message: v.object({ ... }),          // payload validator
  defaultMaxAttempts?: number,          // default: 3
  defaultVisibilityTimeoutMs?: number,  // default: 30000
})
```

#### `.api(query, mutation)`

Returns: `{ peek, claim, ack, nack, publish, publishBatch }`

Claimed messages have `{ id, claimId, payload, attempts }`.

### Library Mode — `MessageQueue` (from `convex-mq/table`)

```ts
new MessageQueue(tableName, fields, options?)
```

- `tableName` — must match your schema table name
- `fields` — validator fields (same as passed to `messageQueueTable()`)
- `options.defaultMaxAttempts` — default: 3
- `options.defaultVisibilityTimeoutMs` — default: 30000
- `options.modulePath` — defaults to `tableName`

#### `.api(query, mutation, filterConfig?)`

Returns: `{ peek, claim, ack, nack, publish, publishBatch, reclaimStale }`

Optional `filterConfig`:

- `filterArgs` — validator fields for filter parameters
- `filter(q, args)` — function that applies index filters, must return an ordered query

Claimed messages have `{ id, claimId, data, attempts }` (note: `data` not `payload`).

### `messageQueueTable(fields)` (from `convex-mq/table`)

Schema helper that adds system fields and the default `by_status` index. Chain `.index()` to add custom indexes (prefix with `"status"` for filtered consumption).

### `consume(client, fns, handler, options?)`

Reactive consumer using `ConvexClient` subscriptions.

- `client` — `ConvexClient` instance
- `fns` — queue module (e.g., `api.emailQueue`)
- `handler` — `async (messages) => void`
- `options.batchSize` — max messages per claim (default 10)
- Any additional keys are forwarded to `peek`/`claim` as filter args

Returns a `stop()` function.

### `consumePolling(client, fns, handler, options?)`

Polling-based consumer using `ConvexHttpClient`.

- `options.batchSize` — max messages per claim (default 10)
- `options.pollIntervalMs` — polling interval (default 1000)
- Any additional keys are forwarded to `peek`/`claim` as filter args

Returns an `AbortController`.

## License

MIT
