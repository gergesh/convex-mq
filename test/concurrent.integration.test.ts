/**
 * Integration test: two queues, two concurrent consumers per queue.
 * Verifies no message is double-processed.
 *
 * Run with: bun test test/concurrent.integration.test.ts
 */
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { consume } from "../src/client/client.js";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL ?? "https://wonderful-peccary-169.convex.cloud";

async function drainOne(http: ConvexHttpClient, q: { claim: any; ack: any }) {
  for (let i = 0; i < 10; i++) {
    const claimed = await http.mutation(q.claim, { limit: 100 });
    if (claimed.length === 0) break;
    for (const msg of claimed) {
      await http.mutation(q.ack, { messageId: msg.id, claimId: msg.claimId });
    }
  }
}

async function drainAll(http: ConvexHttpClient) {
  await drainOne(http, api.emailQueue);
  await drainOne(http, api.taskQueue);
}

describe("concurrent consumers", () => {
  const http = new ConvexHttpClient(CONVEX_URL);

  beforeEach(async () => {
    await drainAll(http);
  });

  afterEach(async () => {
    await drainAll(http);
  });

  test("two consumers on the same queue never double-process", async () => {
    const MESSAGE_COUNT = 20;
    const processed: string[] = [];

    // Publish 20 messages
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      await http.mutation(api.emailQueue.publish, {
        to: `concurrent-${i}@test.com`,
        subject: `Msg ${i}`,
        body: `Body ${i}`,
      });
    }

    expect(await http.query(api.emailQueue.peek, {})).toBe(true);

    // Start two competing consumers
    const client1 = new ConvexClient(CONVEX_URL);
    const client2 = new ConvexClient(CONVEX_URL);

    const makeHandler = (name: string) => {
      return async (messages: Array<{ id: string; payload: any; attempts: number }>) => {
        for (const msg of messages) {
          await new Promise((r) => setTimeout(r, 10));
          processed.push(`${name}:${msg.payload.to}`);
        }
      };
    };

    await new Promise((r) => setTimeout(r, 1000));

    const stop1 = consume(client1, api.emailQueue, makeHandler("consumer1"), { batchSize: 3 });

    const stop2 = consume(client2, api.emailQueue, makeHandler("consumer2"), { batchSize: 3 });

    const deadline = Date.now() + 30_000;
    while (processed.length < MESSAGE_COUNT && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }

    stop1();
    stop2();
    await client1.close();
    await client2.close();

    console.log(`Processed ${processed.length} messages:`, processed.sort());

    // Core assertion: every message processed exactly once
    const emails = processed.map((p) => p.split(":")[1]).sort();
    const expected = Array.from(
      { length: MESSAGE_COUNT },
      (_, i) => `concurrent-${i}@test.com`,
    ).sort();

    expect(emails).toEqual(expected);

    const unique = new Set(emails);
    expect(unique.size).toBe(MESSAGE_COUNT);

    const c1Count = processed.filter((p) => p.startsWith("consumer1:")).length;
    const c2Count = processed.filter((p) => p.startsWith("consumer2:")).length;
    console.log(`Consumer1: ${c1Count}, Consumer2: ${c2Count}`);
    expect(c1Count + c2Count).toBe(MESSAGE_COUNT);

    expect(await http.query(api.emailQueue.peek, {})).toBe(false);
  }, 45_000);

  test("two different queues are fully isolated", async () => {
    await http.mutation(api.emailQueue.publish, {
      to: "email-only@test.com",
      subject: "Email",
      body: "Body",
    });

    await http.mutation(api.taskQueue.publish, {
      action: "process_image",
      data: { url: "https://example.com/img.png" },
    });

    expect(await http.query(api.emailQueue.peek, {})).toBe(true);
    expect(await http.query(api.taskQueue.peek, {})).toBe(true);

    // Claim from email queue — should NOT affect task queue
    const emailClaimed = await http.mutation(api.emailQueue.claim, {
      limit: 10,
    });
    expect(emailClaimed).toHaveLength(1);
    expect(emailClaimed[0].payload.to).toBe("email-only@test.com");

    expect(await http.query(api.taskQueue.peek, {})).toBe(true);

    const taskClaimed = await http.mutation(api.taskQueue.claim, { limit: 10 });
    expect(taskClaimed).toHaveLength(1);
    expect(taskClaimed[0].payload.action).toBe("process_image");

    await http.mutation(api.emailQueue.ack, {
      messageId: emailClaimed[0].id,
      claimId: emailClaimed[0].claimId,
    });
    await http.mutation(api.taskQueue.ack, {
      messageId: taskClaimed[0].id,
      claimId: taskClaimed[0].claimId,
    });

    expect(await http.query(api.emailQueue.peek, {})).toBe(false);
    expect(await http.query(api.taskQueue.peek, {})).toBe(false);
  }, 15_000);
});
