import type { FunctionReference } from "convex/server";
import type { ClaimedMessage } from "./index.js";

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
        } catch {
          // Batch failed — process individually so partial success is possible.
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
