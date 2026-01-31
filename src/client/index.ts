import type {
  FunctionReference,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import type { Infer, VObject } from "convex/values";

/**
 * Structural type for the component's public API surface.
 */
type PublicApi = {
  public: {
    publish: FunctionReference<"mutation", "internal", any, any>;
    publishBatch: FunctionReference<"mutation", "internal", any, any>;
    peek: FunctionReference<"query", "internal", any, any>;
    claim: FunctionReference<"mutation", "internal", any, any>;
    ack: FunctionReference<"mutation", "internal", any, any>;
    nack: FunctionReference<"mutation", "internal", any, any>;
  };
};

/** A branded string identifying a message in the queue. */
export type MessageId = string & { readonly __messageId: unique symbol };

export type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};

export type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};

export interface MessageQueueOptions {
  /** Max delivery attempts before the message is dropped. Defaults to 3. */
  defaultMaxAttempts?: number;
  /** Visibility timeout in ms. Defaults to 30 000. */
  defaultVisibilityTimeoutMs?: number;
}

export interface ClaimedMessage<T> {
  id: MessageId;
  claimId: string;
  payload: T;
  attempts: number;
}

/** Returned by nack when a message has exhausted all retries. */
export interface ExhaustedMessage<T> {
  exhausted: true;
  payload: T;
  attempts: number;
  error: string;
}

/**
 * Typed client wrapper for the message queue component.
 *
 * @example
 * ```ts
 * import { query, mutation } from "./_generated/server";
 * import { components } from "./_generated/api";
 *
 * const emailQueue = new MessageQueue(components.emailQueue, {
 *   message: v.object({ to: v.string(), body: v.string() }),
 * });
 *
 * // Generates typed peek/claim/ack/nack/publish/publishBatch exports
 * export const { peek, claim, ack, nack, publish, publishBatch } =
 *   emailQueue.api(query, mutation);
 * ```
 */
export class MessageQueue<V extends VObject<any, any, any>, Payload = Infer<V>> {
  public component: PublicApi;
  private validator: V;
  private opts: Required<
    Pick<MessageQueueOptions, "defaultMaxAttempts" | "defaultVisibilityTimeoutMs">
  >;

  constructor(component: PublicApi, config: { message: V } & MessageQueueOptions) {
    this.component = component;
    this.validator = config.message;
    this.opts = {
      defaultMaxAttempts: config.defaultMaxAttempts ?? 3,
      defaultVisibilityTimeoutMs: config.defaultVisibilityTimeoutMs ?? 30_000,
    };
  }

  /**
   * Generate standard peek/claim/ack/nack function exports.
   *
   * Eliminates the boilerplate of writing individual query/mutation wrappers.
   * Pass in your app's `query` and `mutation` builders directly.
   * Users still write custom publish wrappers since the args vary per queue.
   *
   * @example
   * ```ts
   * import { query, mutation } from "./_generated/server";
   *
   * const emailQueue = new MessageQueue(components.emailQueue, {
   *   message: v.object({ to: v.string(), body: v.string() }),
   * });
   *
   * // One line instead of ~55 lines of boilerplate
   * export const { peek, claim, ack, nack, publish, publishBatch } =
   *   emailQueue.api(query, mutation);
   *
   * // Or use internalQuery/internalMutation for deploy-key-only access:
   * export const { peek, claim, ack, nack } =
   *   emailQueue.api(internalQuery, internalMutation);
   * ```
   */
  api<DataModel extends GenericDataModel, Visibility extends "public" | "internal" = "public">(
    query: QueryBuilder<DataModel, Visibility>,
    mutation: MutationBuilder<DataModel, Visibility>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      peek: query({
        args: {},
        handler: async (ctx) => self.peek(ctx),
      }),

      claim: mutation({
        args: { limit: v.optional(v.number()) },
        handler: async (ctx, args) => self.claim(ctx, args.limit),
      }),

      ack: mutation({
        args: { messageId: v.string(), claimId: v.string() },
        handler: async (ctx, args) => self.ack(ctx, args.messageId, args.claimId),
      }),

      nack: mutation({
        args: {
          messageId: v.string(),
          claimId: v.string(),
          error: v.optional(v.string()),
        },
        handler: async (ctx, args) => self.nack(ctx, args.messageId, args.claimId, args.error),
      }),

      publish: mutation({
        args: self.validator.fields,
        handler: async (ctx, args) => self.publish(ctx, args as Payload),
      }),

      publishBatch: mutation({
        args: { messages: v.array(v.object(self.validator.fields)) },
        handler: async (ctx, args) => self.publishBatch(ctx, args.messages as Payload[]),
      }),
    };
  }

  /** Publish a single message. */
  async publish(
    ctx: RunMutationCtx,
    message: Payload,
    options?: { maxAttempts?: number; visibilityTimeoutMs?: number },
  ): Promise<MessageId> {
    const id = await ctx.runMutation(this.component.public.publish, {
      payload: message,
      maxAttempts: options?.maxAttempts ?? this.opts.defaultMaxAttempts,
      visibilityTimeoutMs: options?.visibilityTimeoutMs ?? this.opts.defaultVisibilityTimeoutMs,
    });
    return id as MessageId;
  }

  /** Publish multiple messages at once. */
  async publishBatch(
    ctx: RunMutationCtx,
    messages: Payload[],
    options?: { maxAttempts?: number; visibilityTimeoutMs?: number },
  ): Promise<MessageId[]> {
    const ids = await ctx.runMutation(this.component.public.publishBatch, {
      messages: messages.map((payload) => ({
        payload,
        maxAttempts: options?.maxAttempts ?? this.opts.defaultMaxAttempts,
        visibilityTimeoutMs: options?.visibilityTimeoutMs ?? this.opts.defaultVisibilityTimeoutMs,
      })),
    });
    return ids as MessageId[];
  }

  /** Check whether there are pending messages. */
  async peek(ctx: RunQueryCtx): Promise<boolean> {
    return await ctx.runQuery(this.component.public.peek, {});
  }

  /** Claim up to `limit` messages for processing. */
  async claim(ctx: RunMutationCtx, limit?: number): Promise<ClaimedMessage<Payload>[]> {
    const raw = await ctx.runMutation(this.component.public.claim, { limit });
    return raw as ClaimedMessage<Payload>[];
  }

  /**
   * Acknowledge successful processing. Deletes the message.
   * Requires the claimId from the claim result to prove lease ownership.
   */
  async ack(ctx: RunMutationCtx, messageId: MessageId | string, claimId: string): Promise<void> {
    await ctx.runMutation(this.component.public.ack, {
      messageId: messageId as string,
      claimId,
    });
  }

  /**
   * Negative-acknowledge a message.
   * Requires the claimId from the claim result to prove lease ownership.
   * If retries remain, returns `null` (message re-queued).
   * If exhausted, deletes the message and returns the payload
   * so the caller can handle it (log, dead-letter, etc.).
   */
  async nack(
    ctx: RunMutationCtx,
    messageId: MessageId | string,
    claimId: string,
    error?: string,
  ): Promise<ExhaustedMessage<Payload> | null> {
    const result = await ctx.runMutation(this.component.public.nack, {
      messageId: messageId as string,
      claimId,
      error,
    });
    return result as ExhaustedMessage<Payload> | null;
  }
}
