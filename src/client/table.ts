/**
 * Library mode: user owns the table, full index/query power.
 *
 * @example
 * ```ts
 * // convex/schema.ts
 * import { messageQueueTable } from "convex-mq/table";
 *
 * export default defineSchema({
 *   tasks: messageQueueTable({
 *     worker: v.string(),
 *     task: v.string(),
 *   }).index("by_worker", ["status", "worker", "_creationTime"]),
 * });
 * ```
 *
 * ```ts
 * // convex/tasks.ts
 * import { MessageQueue } from "convex-mq/table";
 *
 * const taskQueue = new MessageQueue("tasks", {
 *   worker: v.string(),
 *   task: v.string(),
 * });
 *
 * // Module path defaults to table name ("tasks" → "tasks:reclaimStale")
 * export const { peek, claim, ack, nack, publish, reclaimStale } =
 *   taskQueue.api(internalQuery, internalMutation);
 * ```
 */
import {
  defineTable,
  makeFunctionReference,
  type GenericDataModel,
  type GenericDatabaseReader,
  type GenericDatabaseWriter,
  type MutationBuilder,
  type OrderedQuery,
  type QueryBuilder,
  type QueryInitializer,
} from "convex/server";
import { v } from "convex/values";
import type { GenericId, PropertyValidators, Infer } from "convex/values";

// ---------------------------------------------------------------------------
// Schema helper
// ---------------------------------------------------------------------------

/** System fields added by the message queue. */
const systemFields = {
  status: v.union(v.literal("pending"), v.literal("claimed")),
  attempts: v.number(),
  maxAttempts: v.number(),
  visibilityTimeoutMs: v.number(),
  claimId: v.optional(v.string()),
} as const;

/**
 * Define a message queue table with user fields + system fields.
 *
 * Returns a `defineTable(...)` with a default `by_status` index.
 * Chain `.index(...)` to add custom indexes for filtered consumption.
 *
 * @example
 * ```ts
 * tasks: messageQueueTable({
 *   worker: v.string(),
 *   fileSize: v.number(),
 * })
 *   .index("by_worker", ["status", "worker", "_creationTime"])
 *   .index("by_size", ["status", "fileSize", "_creationTime"]),
 * ```
 */
export function messageQueueTable<T extends PropertyValidators>(fields: T) {
  return defineTable({
    ...fields,
    ...systemFields,
  }).index("by_status", ["status"] as any);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A branded string identifying a message in the queue. */
export type MessageId = string & { readonly __messageId: unique symbol };

export interface MessageQueueOptions {
  /** Max delivery attempts before the message is dropped. Defaults to 3. */
  defaultMaxAttempts?: number;
  /** Visibility timeout in ms. Defaults to 30 000. */
  defaultVisibilityTimeoutMs?: number;
  /**
   * The module path where queue functions are exported.
   * Used to schedule the reclaimStale visibility timeout handler.
   *
   * Defaults to the table name (convention: `convex/tasks.ts` for table `"tasks"`).
   * Override if your module path differs from the table name.
   */
  modulePath?: string;
}

export interface ClaimedMessage<T> {
  id: MessageId;
  claimId: string;
  data: T;
  attempts: number;
}

/** Returned by nack when a message has exhausted all retries. */
export interface ExhaustedMessage<T> {
  exhausted: true;
  data: T;
  attempts: number;
  error: string;
}

/** Filter config for api() — adds filter args to peek and claim. */
export interface FilterConfig<FilterArgs extends PropertyValidators> {
  filterArgs: FilterArgs;
  filter: (
    q: QueryInitializer<any>,
    args: { [K in keyof FilterArgs]: Infer<FilterArgs[K]> },
  ) => OrderedQuery<any>;
}

// Minimal ctx types for library mode (uses ctx.db directly)
type DbReaderCtx = { db: GenericDatabaseReader<any> };
type DbWriterCtx = {
  db: GenericDatabaseWriter<any>;
  scheduler: {
    runAfter: (delayMs: number, fn: any, args: any) => Promise<any>;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateClaimId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 16; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ---------------------------------------------------------------------------
// MessageQueue class (library mode)
// ---------------------------------------------------------------------------

/**
 * Library-mode message queue. Operates on a user-owned table via `ctx.db`.
 *
 * User fields are stored top-level (not nested under `payload`),
 * enabling custom indexes and filtered queries.
 *
 * @example
 * ```ts
 * // Module path defaults to table name ("tasks" → scheduler calls "tasks:reclaimStale")
 * const taskQueue = new MessageQueue("tasks", {
 *   worker: v.string(),
 *   task: v.string(),
 * });
 *
 * // Unfiltered
 * export const { peek, claim, ack, nack, publish, reclaimStale } =
 *   taskQueue.api(internalQuery, internalMutation);
 *
 * // With filter
 * export const { peek, claim, ack, nack, publish, reclaimStale } =
 *   taskQueue.api(internalQuery, internalMutation, {
 *     filterArgs: { worker: v.string() },
 *     filter: (q, { worker }) => q.withIndex("by_worker", q =>
 *       q.eq("status", "pending").eq("worker", worker)
 *     ),
 *   });
 * ```
 */
export class MessageQueue<
  Fields extends PropertyValidators,
  Payload = { [K in keyof Fields]: Infer<Fields[K]> },
> {
  private tableName: string;
  private fields: Fields;
  private opts: Required<
    Pick<MessageQueueOptions, "defaultMaxAttempts" | "defaultVisibilityTimeoutMs">
  >;

  private modulePath: string;

  constructor(tableName: string, fields: Fields, options?: MessageQueueOptions) {
    this.tableName = tableName;
    this.fields = fields;
    this.modulePath = options?.modulePath ?? tableName;
    this.opts = {
      defaultMaxAttempts: options?.defaultMaxAttempts ?? 3,
      defaultVisibilityTimeoutMs: options?.defaultVisibilityTimeoutMs ?? 30_000,
    };
  }

  /**
   * Generate typed Convex function exports.
   *
   * Without filter config: peek/claim query by the default `by_status` index.
   * With filter config: peek/claim accept additional args and use the user's
   * filter callback to build the query.
   */
  /**
   * Generate typed Convex function exports.
   *
   * The `reclaimStaleFnRef` parameter is a function reference to the
   * `reclaimStale` mutation generated by this method. Since Convex needs
   * a function reference for `ctx.scheduler.runAfter`, you must wire it
   * up after defining the exports:
   *
   * @example
   * ```ts
   * const fns = taskQueue.api(internalQuery, internalMutation);
   * taskQueue.setReclaimRef(fns.reclaimStale);
   * export const { peek, claim, ack, nack, publish, publishBatch, reclaimStale } = fns;
   * ```
   */
  api<
    DataModel extends GenericDataModel,
    Visibility extends "public" | "internal" = "public",
    FA extends PropertyValidators = Record<string, never>,
  >(
    query: QueryBuilder<DataModel, Visibility>,
    mutation: MutationBuilder<DataModel, Visibility>,
    filterConfig?: FilterConfig<FA>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const filterArgs = filterConfig?.filterArgs ?? ({} as FA);

    const fns = {
      peek: query({
        args: { ...filterArgs },
        handler: async (ctx: DbReaderCtx, args: any) => {
          const baseQuery = filterConfig
            ? filterConfig.filter(ctx.db.query(self.tableName), args)
            : ctx.db
                .query(self.tableName)
                .withIndex("by_status", (q: any) => q.eq("status", "pending"))
                .order("asc");
          const first = await baseQuery.first();
          return first !== null;
        },
      }),

      claim: mutation({
        args: { limit: v.optional(v.number()), ...filterArgs },
        handler: async (ctx: DbWriterCtx, args: any) => {
          const limit = args.limit ?? 5;
          const baseQuery = filterConfig
            ? filterConfig.filter(ctx.db.query(self.tableName), args)
            : ctx.db
                .query(self.tableName)
                .withIndex("by_status", (q: any) => q.eq("status", "pending"))
                .order("asc");

          const pending = await baseQuery.take(limit);
          const claimed: ClaimedMessage<Payload>[] = [];

          for (const msg of pending) {
            if (msg.status !== "pending") continue;
            const claimId = generateClaimId();
            await ctx.db.patch(msg._id, {
              status: "claimed",
              claimId,
              attempts: msg.attempts + 1,
            });

            // Schedule visibility timeout
            const reclaimRef = makeFunctionReference<"mutation">(`${self.modulePath}:reclaimStale`);
            await ctx.scheduler.runAfter(msg.visibilityTimeoutMs, reclaimRef, {
              messageId: msg._id,
              claimId,
            });

            // Extract user fields
            const data = {} as any;
            for (const key of Object.keys(self.fields)) {
              data[key] = msg[key];
            }

            claimed.push({
              id: msg._id as unknown as MessageId,
              claimId,
              data: data as Payload,
              attempts: msg.attempts + 1,
            });
          }

          return claimed;
        },
      }),

      ack: mutation({
        args: { messageId: v.string(), claimId: v.string() },
        handler: async (ctx: DbWriterCtx, args: { messageId: string; claimId: string }) => {
          const msg = await ctx.db.get(args.messageId as GenericId<any>);
          if (!msg) throw new Error(`Message not found: ${args.messageId}`);
          if (msg.status !== "claimed") {
            throw new Error(`Cannot ack message with status "${msg.status}", expected "claimed"`);
          }
          if (msg.claimId !== args.claimId) {
            throw new Error("Claim expired: message was reclaimed by another consumer");
          }
          await ctx.db.delete(msg._id);
          return null;
        },
      }),

      nack: mutation({
        args: {
          messageId: v.string(),
          claimId: v.string(),
          error: v.optional(v.string()),
        },
        handler: async (
          ctx: DbWriterCtx,
          args: { messageId: string; claimId: string; error?: string },
        ) => {
          const msg = await ctx.db.get(args.messageId as GenericId<any>);
          if (!msg) throw new Error(`Message not found: ${args.messageId}`);
          if (msg.status !== "claimed") {
            throw new Error(`Cannot nack message with status "${msg.status}", expected "claimed"`);
          }
          if (msg.claimId !== args.claimId) {
            throw new Error("Claim expired: message was reclaimed by another consumer");
          }
          if (msg.attempts >= msg.maxAttempts) {
            // Exhausted — delete and return data
            const data = {} as any;
            for (const key of Object.keys(self.fields)) {
              data[key] = msg[key];
            }
            await ctx.db.delete(msg._id);
            return {
              exhausted: true as const,
              data: data as Payload,
              attempts: msg.attempts,
              error: args.error ?? "",
            };
          }
          // Return to pending
          await ctx.db.patch(msg._id, {
            status: "pending",
            claimId: undefined,
          });
          return null;
        },
      }),

      publish: mutation({
        args: self.fields as any,
        handler: async (ctx: DbWriterCtx, args: any) => {
          const id = await ctx.db.insert(self.tableName, {
            ...args,
            status: "pending",
            attempts: 0,
            maxAttempts: self.opts.defaultMaxAttempts,
            visibilityTimeoutMs: self.opts.defaultVisibilityTimeoutMs,
          });
          return id as unknown as MessageId;
        },
      }),

      publishBatch: mutation({
        args: { messages: v.array(v.object(self.fields as any)) },
        handler: async (ctx: DbWriterCtx, args: { messages: any[] }) => {
          const ids: MessageId[] = [];
          for (const msg of args.messages) {
            const id = await ctx.db.insert(self.tableName, {
              ...msg,
              status: "pending",
              attempts: 0,
              maxAttempts: self.opts.defaultMaxAttempts,
              visibilityTimeoutMs: self.opts.defaultVisibilityTimeoutMs,
            });
            ids.push(id as unknown as MessageId);
          }
          return ids;
        },
      }),

      reclaimStale: mutation({
        args: { messageId: v.string(), claimId: v.string() },
        handler: async (ctx: DbWriterCtx, args: { messageId: string; claimId: string }) => {
          const msg = await ctx.db.get(args.messageId as GenericId<any>);
          if (!msg) return null;
          if (msg.status !== "claimed") return null;
          if (msg.claimId !== args.claimId) return null;
          await ctx.db.patch(msg._id, {
            status: "pending",
            claimId: undefined,
          });
          return null;
        },
      }),
    };

    return fns;
  }
}
