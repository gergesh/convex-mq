import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    payload: v.any(),
    status: v.union(v.literal("pending"), v.literal("claimed")),
    attempts: v.number(),
    maxAttempts: v.number(),
    visibilityTimeoutMs: v.number(),
    claimId: v.optional(v.string()),
  }).index("by_status", ["status"]),
});
