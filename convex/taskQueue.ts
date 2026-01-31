import { MessageQueue } from "../src/client/index.js";
import { components } from "./_generated/api.js";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const taskQueue = new MessageQueue(components.taskQueue, {
  message: v.object({
    action: v.string(),
    data: v.any(),
  }),
  defaultMaxAttempts: 3,
  defaultVisibilityTimeoutMs: 30_000,
});

// All queue operations in one line
export const { peek, claim, ack, nack, publish, publishBatch } = taskQueue.api(query, mutation);
