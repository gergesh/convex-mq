import { defineSchema } from "convex/server";
import { messageQueueTable } from "../src/client/table.js";
import { v } from "convex/values";

export default defineSchema({
  // Library-mode queue table with custom indexes
  workerTasks: messageQueueTable({
    worker: v.string(),
    task: v.string(),
    fileSize: v.number(),
  })
    .index("by_worker", ["status", "worker"])
    .index("by_size", ["status", "fileSize"]),
});
