import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

/**
 * Scheduled by `claim` to run after the visibility timeout.
 * If the message is still "claimed" with the same claimId,
 * the consumer didn't ack/nack in time — return to "pending"
 * so another consumer can pick it up.
 *
 * Always returns to pending, never deletes. Only an explicit
 * nack should exhaust a message and return the payload to the
 * caller for dead-letter handling.
 */
export const reclaimStale = internalMutation({
  args: { messageId: v.string(), claimId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("messages", args.messageId);
    if (id === null) return null;

    const msg = await ctx.db.get(id);
    if (msg === null) return null;
    if (msg.status !== "claimed") return null;

    // Only reclaim if the claimId matches. If it doesn't,
    // the message was already acked/nacked and re-claimed
    // by someone else — this timeout is stale.
    if (msg.claimId !== args.claimId) return null;

    await ctx.db.patch(id, { status: "pending", claimId: undefined });
    return null;
  },
});
