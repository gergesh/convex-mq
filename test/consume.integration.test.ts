/**
 * Integration test for the consume() helper against the live deployment.
 *
 * Run with: bun test test/consume.integration.test.ts
 */
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { consume, consumePolling } from "../src/client/client.js";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL ?? "https://wonderful-peccary-169.convex.cloud";

// Helpers to clean up between tests — ack deletes, so just claim+ack.
async function drainQueue(client: ConvexHttpClient) {
  for (let i = 0; i < 10; i++) {
    const claimed = await client.mutation(api.emailQueue.claim, { limit: 100 });
    if (claimed.length === 0) break;
    for (const msg of claimed) {
      await client.mutation(api.emailQueue.ack, { messageId: msg.id, claimId: msg.claimId });
    }
  }
}

describe("consume() integration", () => {
  const httpClient = new ConvexHttpClient(CONVEX_URL);

  beforeEach(async () => {
    await drainQueue(httpClient);
  });

  afterEach(async () => {
    await drainQueue(httpClient);
  });

  test("consume() reactively processes published messages", async () => {
    const client = new ConvexClient(CONVEX_URL);
    const processed: Array<{ to: string; subject: string; body: string }> = [];

    try {
      const stop = consume(
        client,
        api.emailQueue,
        async (messages) => {
          for (const msg of messages) {
            processed.push(msg.payload);
          }
        },
        { batchSize: 5 },
      );

      // Give the subscription time to establish
      await new Promise((r) => setTimeout(r, 2000));

      // Publish 3 messages in a single batch so there's one atomic
      // peek transition (false → true) rather than 3 sequential ones.
      await httpClient.mutation(api.emailQueue.publishBatch, {
        messages: [
          { to: "integration-1@test.com", subject: "Reactive 1", body: "Body 1" },
          { to: "integration-2@test.com", subject: "Reactive 2", body: "Body 2" },
          { to: "integration-3@test.com", subject: "Reactive 3", body: "Body 3" },
        ],
      });

      // Wait for processing
      const deadline = Date.now() + 10_000;
      while (processed.length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }

      stop();

      expect(processed).toHaveLength(3);
      expect(processed.map((p) => p.to).sort()).toEqual([
        "integration-1@test.com",
        "integration-2@test.com",
        "integration-3@test.com",
      ]);

      const hasPending = await httpClient.query(api.emailQueue.peek, {});
      expect(hasPending).toBe(false);
    } finally {
      await client.close();
    }
  }, 15_000);

  test("consume() nacks on handler failure", async () => {
    const client = new ConvexClient(CONVEX_URL);
    let callCount = 0;

    try {
      const stop = consume(
        client,
        api.emailQueue,
        async () => {
          callCount++;
          throw new Error("handler failure");
        },
        { batchSize: 1 },
      );

      await new Promise((r) => setTimeout(r, 1000));

      await httpClient.mutation(api.emailQueue.publish, {
        to: "fail@test.com",
        subject: "Will fail",
        body: "Body",
      });

      const deadline = Date.now() + 10_000;
      while (callCount < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }

      stop();

      expect(callCount).toBeGreaterThanOrEqual(1);

      await new Promise((r) => setTimeout(r, 500));
      const hasPending = await httpClient.query(api.emailQueue.peek, {});
      expect(hasPending).toBe(true);
    } finally {
      await client.close();
    }
  }, 15_000);

  test("consumePolling() processes messages via polling", async () => {
    const processed: Array<{ to: string; subject: string; body: string }> = [];

    await httpClient.mutation(api.emailQueue.publish, {
      to: "poll-1@test.com",
      subject: "Poll 1",
      body: "Body",
    });
    await httpClient.mutation(api.emailQueue.publish, {
      to: "poll-2@test.com",
      subject: "Poll 2",
      body: "Body",
    });

    const controller = consumePolling(
      httpClient,
      api.emailQueue,
      async (messages) => {
        for (const msg of messages) {
          processed.push(msg.payload);
        }
      },
      { batchSize: 10, pollIntervalMs: 500 },
    );

    const deadline = Date.now() + 10_000;
    while (processed.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    controller.abort();

    expect(processed).toHaveLength(2);
    expect(processed.map((p) => p.to).sort()).toEqual(["poll-1@test.com", "poll-2@test.com"]);

    const hasPending = await httpClient.query(api.emailQueue.peek, {});
    expect(hasPending).toBe(false);
  }, 15_000);
});
