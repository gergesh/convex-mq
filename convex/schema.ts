import { defineSchema } from "convex/server";
import { taskQueue } from "./workerTasks.js";

export default defineSchema({
  workerTasks: taskQueue
    .table()
    .index("by_worker", ["status", "worker"])
    .index("by_size", ["status", "fileSize"]),
});
