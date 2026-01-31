/**
 * Example: authenticated queue setup.
 *
 * - Publishing requires user authentication
 * - Consuming (peek/claim/ack/nack) requires a deploy key (internal functions)
 *
 * This file is a reference — copy the patterns into your own app.
 */

// --- Step 1: Define auth builder (e.g., convex/auth.ts) -------------------

import { customMutation } from "convex-helpers/server/customFunctions";
import { mutation, internalQuery, internalMutation } from "../convex/_generated/server.js";

const authenticatedMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return { ctx: { userId: identity.subject }, args: {} };
  },
});

// --- Step 2: Define queue (e.g., convex/emailQueue.ts) --------------------

import { MessageQueue } from "../src/client/index.js";
import { components } from "../convex/_generated/api.js";
import { v } from "convex/values";

const emailQueue = new MessageQueue(components.emailQueue, {
  message: v.object({
    to: v.string(),
    subject: v.string(),
    body: v.string(),
  }),
});

// Consumer ops — deploy key only.
// Internal functions can only be called from other Convex functions
// or by clients authenticated with a deploy key.
export const { peek, claim, ack, nack } = emailQueue.api(internalQuery, internalMutation);

// Publishing — user auth required.
export const publish = authenticatedMutation({
  args: { to: v.string(), subject: v.string(), body: v.string() },
  handler: async (ctx, args) => emailQueue.publish(ctx, args),
});
