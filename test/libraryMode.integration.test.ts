/**
 * Integration tests for library mode (user-owned table with custom indexes).
 *
 * Tests both unfiltered and filtered queue operations.
 */
import { ConvexHttpClient } from "convex/browser";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL ?? "https://wonderful-peccary-169.convex.cloud";

describe("library mode", () => {
  const client = new ConvexHttpClient(CONVEX_URL);

  async function drainQueue() {
    for (let i = 0; i < 10; i++) {
      const claimed = await client.mutation(api.workerTasks.claim, {
        limit: 100,
      });
      if (claimed.length === 0) break;
      for (const msg of claimed) {
        await client.mutation(api.workerTasks.ack, {
          messageId: msg.id,
          claimId: msg.claimId,
        });
      }
    }
  }

  beforeEach(async () => {
    await drainQueue();
  });

  afterEach(async () => {
    await drainQueue();
  });

  // -----------------------------------------------------------------------
  // Basic operations (unfiltered)
  // -----------------------------------------------------------------------

  test("publish and claim returns flat message data", async () => {
    await client.mutation(api.workerTasks.publish, {
      worker: "worker-1",
      task: "resize",
      fileSize: 1000,
    });

    const claimed = await client.mutation(api.workerTasks.claim, { limit: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].data.worker).toBe("worker-1");
    expect(claimed[0].data.task).toBe("resize");
    expect(claimed[0].data.fileSize).toBe(1000);
    expect(claimed[0].claimId).toBeDefined();
    expect(claimed[0].attempts).toBe(1);

    await client.mutation(api.workerTasks.ack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
    });
  });

  test("peek returns true when messages exist", async () => {
    expect(await client.query(api.workerTasks.peek, {})).toBe(false);

    await client.mutation(api.workerTasks.publish, {
      worker: "worker-1",
      task: "compress",
      fileSize: 500,
    });

    expect(await client.query(api.workerTasks.peek, {})).toBe(true);

    // Clean up
    const claimed = await client.mutation(api.workerTasks.claim, { limit: 1 });
    await client.mutation(api.workerTasks.ack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
    });
  });

  test("nack returns message to pending", async () => {
    await client.mutation(api.workerTasks.publish, {
      worker: "worker-1",
      task: "encode",
      fileSize: 2000,
    });

    const claimed = await client.mutation(api.workerTasks.claim, { limit: 1 });
    await client.mutation(api.workerTasks.nack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
      error: "transient failure",
    });

    // Should be reclaimable
    const reclaimed = await client.mutation(api.workerTasks.claim, { limit: 1 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].attempts).toBe(2);

    await client.mutation(api.workerTasks.ack, {
      messageId: reclaimed[0].id,
      claimId: reclaimed[0].claimId,
    });
  });

  test("ack with wrong claimId is rejected", async () => {
    await client.mutation(api.workerTasks.publish, {
      worker: "worker-1",
      task: "test",
      fileSize: 100,
    });

    const claimed = await client.mutation(api.workerTasks.claim, { limit: 1 });

    await expect(
      client.mutation(api.workerTasks.ack, {
        messageId: claimed[0].id,
        claimId: "wrong-claim-id",
      }),
    ).rejects.toThrow(/Claim expired/);

    // Clean up with correct claimId
    await client.mutation(api.workerTasks.ack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
    });
  });

  test("publishBatch inserts multiple messages", async () => {
    await client.mutation(api.workerTasks.publishBatch, {
      messages: [
        { worker: "worker-1", task: "a", fileSize: 10 },
        { worker: "worker-2", task: "b", fileSize: 20 },
        { worker: "worker-1", task: "c", fileSize: 30 },
      ],
    });

    const claimed = await client.mutation(api.workerTasks.claim, { limit: 10 });
    expect(claimed).toHaveLength(3);

    for (const msg of claimed) {
      await client.mutation(api.workerTasks.ack, {
        messageId: msg.id,
        claimId: msg.claimId,
      });
    }
  });

  // -----------------------------------------------------------------------
  // Filtered operations (by worker)
  // -----------------------------------------------------------------------

  test("filtered peek only sees messages for specified worker", async () => {
    await client.mutation(api.workerTasks.publish, {
      worker: "worker-1",
      task: "task-a",
      fileSize: 100,
    });
    await client.mutation(api.workerTasks.publish, {
      worker: "worker-2",
      task: "task-b",
      fileSize: 200,
    });

    // Filtered peek for worker-1 — should see messages
    expect(await client.query(api.workerTasks.peekByWorker, { worker: "worker-1" })).toBe(true);

    // Filtered peek for worker-3 — no messages
    expect(await client.query(api.workerTasks.peekByWorker, { worker: "worker-3" })).toBe(false);
  });

  test("filtered claim only returns messages for specified worker", async () => {
    await client.mutation(api.workerTasks.publishBatch, {
      messages: [
        { worker: "worker-1", task: "a", fileSize: 10 },
        { worker: "worker-2", task: "b", fileSize: 20 },
        { worker: "worker-1", task: "c", fileSize: 30 },
        { worker: "worker-2", task: "d", fileSize: 40 },
      ],
    });

    // Claim for worker-1 only
    const w1 = await client.mutation(api.workerTasks.claimByWorker, {
      worker: "worker-1",
      limit: 10,
    });
    expect(w1).toHaveLength(2);
    expect(w1.every((m: any) => m.data.worker === "worker-1")).toBe(true);

    // Claim for worker-2 only
    const w2 = await client.mutation(api.workerTasks.claimByWorker, {
      worker: "worker-2",
      limit: 10,
    });
    expect(w2).toHaveLength(2);
    expect(w2.every((m: any) => m.data.worker === "worker-2")).toBe(true);

    // Clean up
    for (const msg of [...w1, ...w2]) {
      await client.mutation(api.workerTasks.ack, {
        messageId: msg.id,
        claimId: msg.claimId,
      });
    }
  });

  test("workers don't interfere with each other", async () => {
    // Publish messages for different workers
    await client.mutation(api.workerTasks.publish, {
      worker: "worker-1",
      task: "exclusive-1",
      fileSize: 100,
    });
    await client.mutation(api.workerTasks.publish, {
      worker: "worker-2",
      task: "exclusive-2",
      fileSize: 200,
    });

    // Worker-1 claims its message
    const w1Claimed = await client.mutation(api.workerTasks.claimByWorker, {
      worker: "worker-1",
      limit: 10,
    });
    expect(w1Claimed).toHaveLength(1);
    expect(w1Claimed[0].data.task).toBe("exclusive-1");

    // Worker-2's message is still pending
    expect(await client.query(api.workerTasks.peekByWorker, { worker: "worker-2" })).toBe(true);

    // Worker-2 claims its message
    const w2Claimed = await client.mutation(api.workerTasks.claimByWorker, {
      worker: "worker-2",
      limit: 10,
    });
    expect(w2Claimed).toHaveLength(1);
    expect(w2Claimed[0].data.task).toBe("exclusive-2");

    // Ack both
    await client.mutation(api.workerTasks.ack, {
      messageId: w1Claimed[0].id,
      claimId: w1Claimed[0].claimId,
    });
    await client.mutation(api.workerTasks.ack, {
      messageId: w2Claimed[0].id,
      claimId: w2Claimed[0].claimId,
    });

    // Both workers' queues are empty
    expect(await client.query(api.workerTasks.peekByWorker, { worker: "worker-1" })).toBe(false);
    expect(await client.query(api.workerTasks.peekByWorker, { worker: "worker-2" })).toBe(false);
  });
});
