import { MessageQueue } from "../src/client/index.js";
import { components } from "./_generated/api.js";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const emailQueue = new MessageQueue(components.emailQueue, {
  message: v.object({
    to: v.string(),
    subject: v.string(),
    body: v.string(),
  }),
  defaultMaxAttempts: 3,
  defaultVisibilityTimeoutMs: 30_000,
});

// All queue operations in one line
export const { peek, claim, ack, nack, publish, publishBatch } = emailQueue.api(query, mutation);
