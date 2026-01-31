/**
 * Library-mode queue: user-owned table with custom indexes.
 * Supports filtered consumption by worker name.
 */
import { MessageQueue } from "../src/client/table.js";
import { v } from "convex/values";
import { query, mutation } from "./_generated/server.js";

export const taskQueue = new MessageQueue("workerTasks", {
  worker: v.string(),
  task: v.string(),
  fileSize: v.number(),
});

// Unfiltered — standard queue operations
export const { peek, claim, ack, nack, publish, publishBatch, reclaimStale } = taskQueue.api(
  query,
  mutation,
);

// Filtered by worker — peek/claim only return messages for a specific worker
const filteredFns = taskQueue.api(query, mutation, {
  filterArgs: { worker: v.string() },
  filter: (q, { worker }) =>
    q.withIndex("by_worker", (idx: any) => idx.eq("status", "pending").eq("worker", worker)),
});

export const peekByWorker = filteredFns.peek;
export const claimByWorker = filteredFns.claim;
