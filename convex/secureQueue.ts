/**
 * Secure queue: consumer ops are internal (deploy key only),
 * publish is a public mutation (would use authenticatedMutation in production).
 */
import { MessageQueue } from "../src/client/index.js";
import { components } from "./_generated/api.js";
import { v } from "convex/values";
import { mutation, internalQuery, internalMutation } from "./_generated/server.js";

const secureQueue = new MessageQueue(components.secureQueue, {
  message: v.object({
    data: v.string(),
  }),
});

// Consumer ops — internal only (deploy key or other Convex functions)
export const { peek, claim, ack, nack } = secureQueue.api(internalQuery, internalMutation);

// Publish — public for this test (in production, use authenticatedMutation)
export const publish = mutation({
  args: { data: v.string() },
  handler: async (ctx, args) => secureQueue.publish(ctx, args),
});
