import type { FunctionReference } from "convex/server";
import type { ClaimedMessage, PendingMessage } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the ConvexClient / ConvexHttpClient interface
 * that `consume` needs.  Works with both `ConvexClient` (reactive)
 * and `ConvexHttpClient` (polling).
 */
interface ConvexSubscriptionClient {
  onUpdate<T>(
    query: FunctionReference<"query", any, any, T>,
    args: Record<string, unknown>,
    callback: (result: T) => void,
  ): () => void;
  mutation<T>(
    mutation: FunctionReference<"mutation", any, any, T>,
    args: Record<string, unknown>,
  ): Promise<T>;
}

interface ConvexPollingClient {
  query<T>(
    query: FunctionReference<"query", any, any, T>,
    args: Record<string, unknown>,
  ): Promise<T>;
  mutation<T>(
    mutation: FunctionReference<"mutation", any, any, T>,
    args: Record<string, unknown>,
  ): Promise<T>;
}

/**
 * References to the host app's queue functions.
 *
 * Generic over `T` so the payload type flows from the function
 * references into the handler — no manual type annotation needed.
 *
 * Structurally compatible with the module exported by `api()`,
 * so you can pass `api.emailQueue` directly.
 */
export interface QueueFunctions<T> {
  peek: FunctionReference<"query", any, any, boolean>;
  claim: FunctionReference<"mutation", any, any, ClaimedMessage<T>[]>;
  ack: FunctionReference<"mutation", any, any, null>;
  nack: FunctionReference<"mutation", any, any, any>;
}

export interface ConsumeOptions {
  /** Maximum messages to claim per batch. Defaults to 10. */
  batchSize?: number;
}

export interface ConsumePollingOptions extends ConsumeOptions {
  /** Polling interval in milliseconds. Defaults to 1000. */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Reactive consumer (ConvexClient with onUpdate / subscribe)
// ---------------------------------------------------------------------------

/**
 * High-level consume loop using a reactive subscription.
 *
 * Subscribes to the peek query — whenever new pending messages appear,
 * claims a batch, runs the handler, and acks/nacks each message.
 *
 * Returns a cleanup function that stops the subscription.
 *
 * @example
 * ```ts
 * import { ConvexClient } from "convex/browser";
 * import { consume } from "convex-mq/client";
 * import { api } from "../convex/_generated/api.js";
 *
 * const client = new ConvexClient(process.env.CONVEX_URL!);
 *
 * const stop = consume(client, api.emailQueue, async (messages) => {
 *   for (const msg of messages) {
 *     await sendEmail(msg.payload.to, msg.payload.body);
 *   }
 * });
 *
 * // Later: stop();
 * ```
 */
export function consume<T>(
  client: ConvexSubscriptionClient,
  fns: QueueFunctions<T>,
  handler: (messages: ClaimedMessage<T>[]) => Promise<void>,
  options?: ConsumeOptions,
): () => void {
  const { batchSize = 10 } = options ?? {};
  let processing = false;
  let hasPending = false;

  const processLoop = async () => {
    if (processing) return;
    processing = true;
    try {
      // Keep claiming until the queue is empty.
      // This drains fully even if new messages arrive mid-processing,
      // because the subscription callback updates `hasPending`.
      while (hasPending) {
        const claimed = (await client.mutation(fns.claim, {
          limit: batchSize,
        })) as ClaimedMessage<T>[];

        if (claimed.length === 0) {
          // Another consumer beat us to it. Wait for next update.
          hasPending = false;
          break;
        }

        // Try the handler for the whole batch. On success, ack all.
        // On failure, ack/nack individually.
        try {
          await handler(claimed);
          await Promise.all(
            claimed.map((msg) =>
              client.mutation(fns.ack, { messageId: msg.id, claimId: msg.claimId }),
            ),
          );
        } catch (batchError) {
          // Batch failed — process individually so partial success is possible.
          // The batchError is intentionally not logged here since individual
          // message failures will be captured via nack below.
          void batchError;
          for (const msg of claimed) {
            try {
              await handler([msg]);
              await client.mutation(fns.ack, { messageId: msg.id, claimId: msg.claimId });
            } catch (msgError) {
              const errorStr = msgError instanceof Error ? msgError.message : String(msgError);
              await client.mutation(fns.nack, {
                messageId: msg.id,
                claimId: msg.claimId,
                error: errorStr,
              });
            }
          }
        }

        // If we got fewer than batchSize, we've likely drained.
        // But hasPending may have been set true by the subscription
        // callback while we were processing, so loop re-checks.
        if (claimed.length < batchSize) {
          hasPending = false;
        }
      }
    } finally {
      processing = false;
      // If new messages arrived while we were processing,
      // the subscription callback set hasPending but couldn't
      // start processLoop (processing was true). Re-enter now.
      if (hasPending) {
        void processLoop();
      }
    }
  };

  const unsubscribe = client.onUpdate(fns.peek, {}, (result: boolean) => {
    hasPending = result;
    if (hasPending) {
      void processLoop();
    }
  });

  return unsubscribe;
}

// ---------------------------------------------------------------------------
// Polling consumer (ConvexHttpClient or any client without onUpdate)
// ---------------------------------------------------------------------------

/**
 * Polling-based consume loop. Useful when using `ConvexHttpClient`
 * or running in environments without WebSocket support.
 *
 * Returns an AbortController — call `.abort()` to stop.
 *
 * @example
 * ```ts
 * import { ConvexHttpClient } from "convex/browser";
 * import { consumePolling } from "convex-mq/client";
 * import { api } from "../convex/_generated/api.js";
 *
 * const client = new ConvexHttpClient(process.env.CONVEX_URL!);
 *
 * const controller = consumePolling(client, api.emailQueue, async (messages) => {
 *   for (const msg of messages) {
 *     await sendEmail(msg.payload.to, msg.payload.body);
 *   }
 * }, { pollIntervalMs: 2000 });
 *
 * // Later: controller.abort();
 * ```
 */
export function consumePolling<T>(
  client: ConvexPollingClient,
  fns: QueueFunctions<T>,
  handler: (messages: ClaimedMessage<T>[]) => Promise<void>,
  options?: ConsumePollingOptions,
): AbortController {
  const { batchSize = 10, pollIntervalMs = 1000 } = options ?? {};
  const controller = new AbortController();

  const poll = async () => {
    while (!controller.signal.aborted) {
      try {
        const hasPending = (await client.query(fns.peek, {})) as boolean;

        if (hasPending) {
          const claimed = (await client.mutation(fns.claim, {
            limit: batchSize,
          })) as ClaimedMessage<T>[];

          for (const msg of claimed) {
            try {
              await handler([msg]);
              await client.mutation(fns.ack, { messageId: msg.id, claimId: msg.claimId });
            } catch (msgError) {
              const errorStr = msgError instanceof Error ? msgError.message : String(msgError);
              await client.mutation(fns.nack, {
                messageId: msg.id,
                claimId: msg.claimId,
                error: errorStr,
              });
            }
          }
        }
      } catch (err) {
        // Log but don't crash the loop.
        console.error("[convex-mq] poll error:", err);
      }

      // Wait before next poll.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  };

  void poll();
  return controller;
}

// ---------------------------------------------------------------------------
// Filtered consumers (for custom queries)
// ---------------------------------------------------------------------------

/**
 * References for filtered consumption.
 * Uses a custom query that returns filtered pending messages,
 * and claimByIds to claim specific messages.
 */
export interface FilteredQueueFunctions<T> {
  /** Custom query that returns filtered pending messages */
  list: FunctionReference<"query", any, any, PendingMessage<T>[]>;
  /** Claim specific messages by ID */
  claimByIds: FunctionReference<"mutation", any, any, ClaimedMessage<T>[]>;
  ack: FunctionReference<"mutation", any, any, null>;
  nack: FunctionReference<"mutation", any, any, any>;
}

export interface ConsumeFilteredOptions {
  /** Maximum messages to claim per batch. Defaults to 10. */
  batchSize?: number;
}

export interface ConsumeFilteredPollingOptions extends ConsumeFilteredOptions {
  /** Polling interval in milliseconds. Defaults to 1000. */
  pollIntervalMs?: number;
}

/**
 * Consume messages using a custom filtered query.
 *
 * Subscribe to your custom query that returns filtered pending messages,
 * then claim and process only those messages.
 *
 * @example
 * ```ts
 * // In your Convex app, define a filtered query:
 * export const getTasksForWorker = query({
 *   args: { worker: v.string() },
 *   handler: async (ctx, args) => {
 *     const pending = await taskQueue.listPending(ctx);
 *     return pending.filter(msg => msg.payload.worker === args.worker);
 *   },
 * });
 *
 * // Then consume with filtering:
 * const stop = consumeFiltered(
 *   client,
 *   {
 *     list: api.taskQueue.getTasksForWorker,
 *     claimByIds: api.taskQueue.claimByIds,
 *     ack: api.taskQueue.ack,
 *     nack: api.taskQueue.nack,
 *   },
 *   { worker: "worker-1" },  // args for your custom query
 *   async (messages) => {
 *     for (const msg of messages) {
 *       await processTask(msg.payload);
 *     }
 *   },
 * );
 * ```
 */
export function consumeFiltered<T, Args extends Record<string, unknown>>(
  client: ConvexSubscriptionClient,
  fns: FilteredQueueFunctions<T>,
  queryArgs: Args,
  handler: (messages: ClaimedMessage<T>[]) => Promise<void>,
  options?: ConsumeFilteredOptions,
): () => void {
  const { batchSize = 10 } = options ?? {};
  let processing = false;
  let pendingMessages: PendingMessage<T>[] = [];

  const processLoop = async () => {
    if (processing) return;
    processing = true;
    try {
      while (pendingMessages.length > 0) {
        // Take up to batchSize message IDs to claim
        const toClaim = pendingMessages.slice(0, batchSize);
        const messageIds = toClaim.map((m) => m.id);

        const claimed = (await client.mutation(fns.claimByIds, {
          messageIds,
        })) as ClaimedMessage<T>[];

        if (claimed.length === 0) {
          // All were claimed by another consumer, wait for next update
          pendingMessages = [];
          break;
        }

        // Remove claimed messages from our pending list
        const claimedIds = new Set(claimed.map((m) => m.id));
        pendingMessages = pendingMessages.filter((m) => !claimedIds.has(m.id));

        // Try the handler for the whole batch
        try {
          await handler(claimed);
          await Promise.all(
            claimed.map((msg) =>
              client.mutation(fns.ack, { messageId: msg.id, claimId: msg.claimId }),
            ),
          );
        } catch (batchError) {
          // Batch failed — process individually so partial success is possible.
          // The batchError is intentionally not logged here since individual
          // message failures will be captured via nack below.
          void batchError;
          for (const msg of claimed) {
            try {
              await handler([msg]);
              await client.mutation(fns.ack, { messageId: msg.id, claimId: msg.claimId });
            } catch (msgError) {
              const errorStr = msgError instanceof Error ? msgError.message : String(msgError);
              await client.mutation(fns.nack, {
                messageId: msg.id,
                claimId: msg.claimId,
                error: errorStr,
              });
            }
          }
        }
      }
    } finally {
      processing = false;
      if (pendingMessages.length > 0) {
        void processLoop();
      }
    }
  };

  const unsubscribe = client.onUpdate(fns.list, queryArgs, (result: PendingMessage<T>[]) => {
    pendingMessages = result;
    if (pendingMessages.length > 0) {
      void processLoop();
    }
  });

  return unsubscribe;
}

/**
 * Polling-based consume with custom filtering.
 *
 * @example
 * ```ts
 * const controller = consumeFilteredPolling(
 *   client,
 *   {
 *     list: api.taskQueue.getTasksForWorker,
 *     claimByIds: api.taskQueue.claimByIds,
 *     ack: api.taskQueue.ack,
 *     nack: api.taskQueue.nack,
 *   },
 *   { worker: "worker-1" },
 *   async (messages) => {
 *     for (const msg of messages) {
 *       await processTask(msg.payload);
 *     }
 *   },
 *   { pollIntervalMs: 2000 },
 * );
 * ```
 */
export function consumeFilteredPolling<T, Args extends Record<string, unknown>>(
  client: ConvexPollingClient,
  fns: FilteredQueueFunctions<T>,
  queryArgs: Args,
  handler: (messages: ClaimedMessage<T>[]) => Promise<void>,
  options?: ConsumeFilteredPollingOptions,
): AbortController {
  const { batchSize = 10, pollIntervalMs = 1000 } = options ?? {};
  const controller = new AbortController();

  const poll = async () => {
    while (!controller.signal.aborted) {
      try {
        const pending = (await client.query(fns.list, queryArgs)) as PendingMessage<T>[];

        if (pending.length > 0) {
          const toClaim = pending.slice(0, batchSize);
          const messageIds = toClaim.map((m) => m.id);

          const claimed = (await client.mutation(fns.claimByIds, {
            messageIds,
          })) as ClaimedMessage<T>[];

          for (const msg of claimed) {
            try {
              await handler([msg]);
              await client.mutation(fns.ack, { messageId: msg.id, claimId: msg.claimId });
            } catch (msgError) {
              const errorStr = msgError instanceof Error ? msgError.message : String(msgError);
              await client.mutation(fns.nack, {
                messageId: msg.id,
                claimId: msg.claimId,
                error: errorStr,
              });
            }
          }
        }
      } catch (err) {
        console.error("[convex-mq] poll error:", err);
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  };

  void poll();
  return controller;
}
