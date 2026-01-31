import { mutation, query } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";

function generateClaimId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 16; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Insert a single message into the queue.
 */
export const publish = mutation({
  args: {
    payload: v.any(),
    maxAttempts: v.optional(v.number()),
    visibilityTimeoutMs: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("messages", {
      payload: args.payload,
      status: "pending",
      attempts: 0,
      maxAttempts: args.maxAttempts ?? 3,
      visibilityTimeoutMs: args.visibilityTimeoutMs ?? 30_000,
    });
    return id as string;
  },
});

/**
 * Insert multiple messages into the queue.
 */
export const publishBatch = mutation({
  args: {
    messages: v.array(
      v.object({
        payload: v.any(),
        maxAttempts: v.optional(v.number()),
        visibilityTimeoutMs: v.optional(v.number()),
      }),
    ),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const ids: string[] = [];
    for (const msg of args.messages) {
      const id = await ctx.db.insert("messages", {
        payload: msg.payload,
        status: "pending",
        attempts: 0,
        maxAttempts: msg.maxAttempts ?? 3,
        visibilityTimeoutMs: msg.visibilityTimeoutMs ?? 30_000,
      });
      ids.push(id as string);
    }
    return ids;
  },
});

/**
 * Reactive signal: are there pending messages?
 * Reads at most one document.
 */
export const peek = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const first = await ctx.db
      .query("messages")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .first();
    return first !== null;
  },
});

/**
 * Atomically claim up to `limit` pending messages.
 * Each claimed message gets a unique `claimId` — ack/nack must
 * provide this claimId to prove they own the lease.
 */
export const claim = mutation({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      id: v.string(),
      claimId: v.string(),
      payload: v.any(),
      attempts: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 1;
    const pending = await ctx.db
      .query("messages")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(limit);

    const claimed: Array<{
      id: string;
      claimId: string;
      payload: unknown;
      attempts: number;
    }> = [];

    for (const msg of pending) {
      const attempts = msg.attempts + 1;
      const claimId = generateClaimId();
      await ctx.db.patch(msg._id, {
        status: "claimed",
        attempts,
        claimId,
      });

      await ctx.scheduler.runAfter(msg.visibilityTimeoutMs, internal.lib.reclaimStale, {
        messageId: msg._id as string,
        claimId,
      });

      claimed.push({
        id: msg._id as string,
        claimId,
        payload: msg.payload,
        attempts,
      });
    }

    return claimed;
  },
});

/**
 * Acknowledge successful processing. Deletes the message.
 *
 * Requires the `claimId` from the claim result. If the message
 * was reclaimed by another consumer (after a visibility timeout),
 * this will throw — preventing stale acks from deleting messages
 * that belong to a different consumer.
 */
export const ack = mutation({
  args: { messageId: v.string(), claimId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("messages", args.messageId);
    if (id === null) {
      throw new Error(`Invalid message ID: ${args.messageId}`);
    }
    const msg = await ctx.db.get(id);
    if (msg === null) {
      throw new Error(`Message not found: ${args.messageId}`);
    }
    if (msg.status !== "claimed") {
      throw new Error(`Cannot ack message with status "${msg.status}" (expected "claimed")`);
    }
    if (msg.claimId !== args.claimId) {
      throw new Error(`Claim expired: message was reclaimed by another consumer`);
    }
    await ctx.db.delete(id);
    return null;
  },
});

/**
 * Negative-acknowledge a message.
 *
 * Requires the `claimId` from the claim result, same as ack.
 *
 * If retries remain: returns to "pending" for redelivery, returns `null`.
 * If exhausted: deletes the message and returns the payload so the
 * caller can decide what to do with it (log, dead-letter, etc.).
 */
export const nack = mutation({
  args: {
    messageId: v.string(),
    claimId: v.string(),
    error: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("messages", args.messageId);
    if (id === null) {
      throw new Error(`Invalid message ID: ${args.messageId}`);
    }
    const msg = await ctx.db.get(id);
    if (msg === null) {
      throw new Error(`Message not found: ${args.messageId}`);
    }
    if (msg.status !== "claimed") {
      throw new Error(`Cannot nack message with status "${msg.status}" (expected "claimed")`);
    }
    if (msg.claimId !== args.claimId) {
      throw new Error(`Claim expired: message was reclaimed by another consumer`);
    }

    if (msg.attempts >= msg.maxAttempts) {
      // Exhausted — delete and return payload to caller
      await ctx.db.delete(id);
      return {
        exhausted: true,
        payload: msg.payload,
        attempts: msg.attempts,
        error: args.error ?? "Max attempts exceeded",
      };
    } else {
      await ctx.db.patch(id, { status: "pending", claimId: undefined });
      return null;
    }
  },
});

/**
 * List pending messages for custom filtering.
 *
 * Returns up to `limit` pending messages with their IDs and payloads.
 * Use this to implement custom filtering logic in your own code,
 * then call `claimByIds` to claim the messages you want.
 */
export const listPending = query({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      id: v.string(),
      payload: v.any(),
      attempts: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const pending = await ctx.db
      .query("messages")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(limit);

    return pending.map((msg) => ({
      id: msg._id as string,
      payload: msg.payload,
      attempts: msg.attempts,
    }));
  },
});

/**
 * Claim specific messages by their IDs.
 *
 * Use this after filtering messages from `listPending` to claim
 * only the ones you want. Messages that are no longer pending
 * (already claimed by another consumer) are silently skipped.
 */
export const claimByIds = mutation({
  args: {
    messageIds: v.array(v.string()),
  },
  returns: v.array(
    v.object({
      id: v.string(),
      claimId: v.string(),
      payload: v.any(),
      attempts: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const claimed: Array<{
      id: string;
      claimId: string;
      payload: unknown;
      attempts: number;
    }> = [];

    for (const messageId of args.messageIds) {
      const id = ctx.db.normalizeId("messages", messageId);
      if (id === null) continue;

      const msg = await ctx.db.get(id);
      if (msg === null) continue;
      if (msg.status !== "pending") continue;

      const attempts = msg.attempts + 1;
      const claimId = generateClaimId();
      await ctx.db.patch(msg._id, {
        status: "claimed",
        attempts,
        claimId,
      });

      await ctx.scheduler.runAfter(msg.visibilityTimeoutMs, internal.lib.reclaimStale, {
        messageId: msg._id as string,
        claimId,
      });

      claimed.push({
        id: msg._id as string,
        claimId,
        payload: msg.payload,
        attempts,
      });
    }

    return claimed;
  },
});
