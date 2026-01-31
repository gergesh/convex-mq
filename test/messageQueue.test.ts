import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import componentSchema from "../src/component/schema.js";
import { api } from "../convex/_generated/api.js";

function setup() {
  const t = convexTest(undefined as any, import.meta.glob("../convex/**/*.*s"));
  t.registerComponent("emailQueue", componentSchema, import.meta.glob("../src/component/**/*.*s"));
  return t;
}

// ---------------------------------------------------------------------------
// Basic lifecycle
// ---------------------------------------------------------------------------

describe("basic lifecycle", () => {
  test("empty queue: peek is false, claim returns nothing", async () => {
    const t = setup();
    expect(await t.query(api.emailQueue.peek)).toBe(false);
    expect(await t.mutation(api.emailQueue.claim, { limit: 10 })).toHaveLength(0);
  });

  test("publish makes peek true", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "alice@test.com",
      subject: "Hello",
      body: "World",
    });
    expect(await t.query(api.emailQueue.peek)).toBe(true);
  });

  test("claim returns payload and moves message out of pending", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "bob@test.com",
      subject: "Test",
      body: "Body",
    });

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].payload).toEqual({ to: "bob@test.com", subject: "Test", body: "Body" });
    expect(claimed[0].attempts).toBe(1);
    expect(claimed[0].id).toBeTypeOf("string");

    expect(await t.query(api.emailQueue.peek)).toBe(false);
  });

  test("claim default limit is 1", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      await t.mutation(api.emailQueue.publish, {
        to: `u${i}@test.com`,
        subject: "s",
        body: "b",
      });
    }
    expect(await t.mutation(api.emailQueue.claim, {})).toHaveLength(1);
  });

  test("ack deletes the message", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "carol@test.com",
      subject: "Ack",
      body: "Body",
    });

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await t.mutation(api.emailQueue.ack, { messageId: claimed[0].id, claimId: claimed[0].claimId });

    // Queue is empty — message is gone, not just "completed"
    expect(await t.query(api.emailQueue.peek)).toBe(false);
    expect(await t.mutation(api.emailQueue.claim, { limit: 10 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Nack and retry
// ---------------------------------------------------------------------------

describe("nack and retry", () => {
  test("nack re-queues message when retries remain", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "dave@test.com",
      subject: "Retry",
      body: "Body",
    });

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    const result = await t.mutation(api.emailQueue.nack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
    });
    expect(result).toBeNull();

    expect(await t.query(api.emailQueue.peek)).toBe(true);

    const reClaimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    expect(reClaimed).toHaveLength(1);
    expect(reClaimed[0].id).toBe(claimed[0].id);
    expect(reClaimed[0].attempts).toBe(2);
  });

  test("nack deletes and returns payload when retries exhausted", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "eve@test.com",
      subject: "Exhaust",
      body: "Body",
    });

    // Exhaust all 3 attempts
    for (let i = 0; i < 2; i++) {
      const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
      const result = await t.mutation(api.emailQueue.nack, {
        messageId: claimed[0].id,
        claimId: claimed[0].claimId,
        error: `fail ${i + 1}`,
      });
      expect(result).toBeNull(); // still has retries
    }

    // 3rd attempt — should exhaust
    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    expect(claimed[0].attempts).toBe(3);
    const result = await t.mutation(api.emailQueue.nack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
      error: "final failure",
    });

    expect(result).toEqual({
      exhausted: true,
      payload: { to: "eve@test.com", subject: "Exhaust", body: "Body" },
      attempts: 3,
      error: "final failure",
    });

    // Message is gone
    expect(await t.query(api.emailQueue.peek)).toBe(false);
    expect(await t.mutation(api.emailQueue.claim, { limit: 10 })).toHaveLength(0);
  });

  test("nack without error string still works", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "a@b.com",
      subject: "s",
      body: "b",
    });

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await t.mutation(api.emailQueue.nack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
    });
    expect(await t.query(api.emailQueue.peek)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

describe("batch operations", () => {
  test("publishBatch inserts multiple messages", async () => {
    const t = setup();

    const ids = await t.mutation(api.emailQueue.publishBatch, {
      messages: [
        { to: "a@test.com", subject: "A", body: "1" },
        { to: "b@test.com", subject: "B", body: "2" },
        { to: "c@test.com", subject: "C", body: "3" },
      ],
    });

    expect(ids).toHaveLength(3);
    ids.forEach((id: unknown) => expect(id).toBeTypeOf("string"));
    expect(await t.query(api.emailQueue.peek)).toBe(true);
  });

  test("claim with limit respects the limit", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publishBatch, {
      messages: Array.from({ length: 5 }, (_, i) => ({
        to: `u${i}@test.com`,
        subject: `s${i}`,
        body: "b",
      })),
    });

    const batch1 = await t.mutation(api.emailQueue.claim, { limit: 2 });
    expect(batch1).toHaveLength(2);
    expect(await t.query(api.emailQueue.peek)).toBe(true);

    const batch2 = await t.mutation(api.emailQueue.claim, { limit: 10 });
    expect(batch2).toHaveLength(3);
    expect(await t.query(api.emailQueue.peek)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("ack on already-acked (deleted) message throws", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "a@test.com",
      subject: "s",
      body: "b",
    });
    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await t.mutation(api.emailQueue.ack, { messageId: claimed[0].id, claimId: claimed[0].claimId });

    await expect(
      t.mutation(api.emailQueue.ack, { messageId: claimed[0].id, claimId: claimed[0].claimId }),
    ).rejects.toThrow(/not found/);
  });

  test("nack on non-claimed message throws", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "a@test.com",
      subject: "s",
      body: "b",
    });

    // Get ID via claim then nack back to pending
    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await t.mutation(api.emailQueue.nack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
    });

    // Now it's pending — nacking again should fail (claimId is stale)
    await expect(
      t.mutation(api.emailQueue.nack, { messageId: claimed[0].id, claimId: claimed[0].claimId }),
    ).rejects.toThrow(/expected "claimed"/);
  });

  test("ack on pending message throws", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "a@test.com",
      subject: "s",
      body: "b",
    });
    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await t.mutation(api.emailQueue.nack, {
      messageId: claimed[0].id,
      claimId: claimed[0].claimId,
    });

    await expect(
      t.mutation(api.emailQueue.ack, { messageId: claimed[0].id, claimId: claimed[0].claimId }),
    ).rejects.toThrow(/expected "claimed"/);
  });

  test("ack with invalid ID throws", async () => {
    const t = setup();
    await expect(
      t.mutation(api.emailQueue.ack, { messageId: "not-a-real-id", claimId: "fake" }),
    ).rejects.toThrow(/Invalid message ID/);
  });

  test("nack with invalid ID throws", async () => {
    const t = setup();
    await expect(
      t.mutation(api.emailQueue.nack, { messageId: "not-a-real-id", claimId: "fake" }),
    ).rejects.toThrow(/Invalid message ID/);
  });
});

// ---------------------------------------------------------------------------
// Visibility timeout / reclaimStale
// ---------------------------------------------------------------------------

describe("visibility timeout", () => {
  test("claimed message returns to pending after timeout", async () => {
    vi.useFakeTimers();
    const t = setup();

    await t.mutation(api.emailQueue.publish, {
      to: "timeout@test.com",
      subject: "Timeout",
      body: "Body",
    });

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    expect(await t.query(api.emailQueue.peek)).toBe(false);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.emailQueue.peek)).toBe(true);

    const reClaimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    expect(reClaimed[0].id).toBe(claimed[0].id);
    expect(reClaimed[0].attempts).toBe(2);

    vi.useRealTimers();
  });

  test("timeout returns message to pending even when retries exhausted", async () => {
    vi.useFakeTimers();
    const t = setup();

    await t.mutation(api.emailQueue.publish, {
      to: "timeout-fail@test.com",
      subject: "Fail",
      body: "Body",
    });

    // Use 2 of 3 attempts via claim+nack
    for (let i = 0; i < 2; i++) {
      const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
      await t.mutation(api.emailQueue.nack, {
        messageId: claimed[0].id,
        claimId: claimed[0].claimId,
      });
    }

    // 3rd claim — then let it time out instead of acking
    await t.mutation(api.emailQueue.claim, { limit: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // reclaimStale always returns to pending — only explicit nack can exhaust
    expect(await t.query(api.emailQueue.peek)).toBe(true);
    const reClaimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    expect(reClaimed).toHaveLength(1);
    expect(reClaimed[0].attempts).toBe(4); // 3 explicit + 1 from reclaim

    vi.useRealTimers();
  });

  test("timeout is no-op if message was already acked", async () => {
    vi.useFakeTimers();
    const t = setup();

    await t.mutation(api.emailQueue.publish, {
      to: "acked@test.com",
      subject: "Acked",
      body: "Body",
    });

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await t.mutation(api.emailQueue.ack, { messageId: claimed[0].id, claimId: claimed[0].claimId });

    // Timeout fires but message is already deleted — should be a no-op
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.emailQueue.peek)).toBe(false);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// claimId lease tokens (race condition prevention)
// ---------------------------------------------------------------------------

describe("claimId lease tokens", () => {
  test("ack with wrong claimId is rejected", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "race@test.com",
      subject: "Race",
      body: "Body",
    });

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await expect(
      t.mutation(api.emailQueue.ack, { messageId: claimed[0].id, claimId: "wrong-claim-id" }),
    ).rejects.toThrow(/Claim expired/);

    // Message is still claimed and can be acked with the correct claimId
    await t.mutation(api.emailQueue.ack, { messageId: claimed[0].id, claimId: claimed[0].claimId });
  });

  test("nack with wrong claimId is rejected", async () => {
    const t = setup();
    await t.mutation(api.emailQueue.publish, {
      to: "race@test.com",
      subject: "Race",
      body: "Body",
    });

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await expect(
      t.mutation(api.emailQueue.nack, { messageId: claimed[0].id, claimId: "wrong-claim-id" }),
    ).rejects.toThrow(/Claim expired/);
  });

  test("stale consumer cannot ack after visibility timeout reclaim", async () => {
    vi.useFakeTimers();
    const t = setup();

    await t.mutation(api.emailQueue.publish, {
      to: "stale@test.com",
      subject: "Stale",
      body: "Body",
    });

    // Consumer A claims the message
    const consumerA = await t.mutation(api.emailQueue.claim, { limit: 1 });

    // Visibility timeout fires — message returns to pending with new claimId
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Consumer B claims the message
    const consumerB = await t.mutation(api.emailQueue.claim, { limit: 1 });
    expect(consumerB[0].id).toBe(consumerA[0].id);
    expect(consumerB[0].claimId).not.toBe(consumerA[0].claimId);

    // Consumer A tries to ack with stale claimId — rejected
    await expect(
      t.mutation(api.emailQueue.ack, { messageId: consumerA[0].id, claimId: consumerA[0].claimId }),
    ).rejects.toThrow(/Claim expired/);

    // Consumer B can still ack successfully
    await t.mutation(api.emailQueue.ack, {
      messageId: consumerB[0].id,
      claimId: consumerB[0].claimId,
    });
    expect(await t.query(api.emailQueue.peek)).toBe(false);

    vi.useRealTimers();
  });

  test("stale consumer cannot nack after visibility timeout reclaim", async () => {
    vi.useFakeTimers();
    const t = setup();

    await t.mutation(api.emailQueue.publish, {
      to: "stale@test.com",
      subject: "Stale",
      body: "Body",
    });

    const consumerA = await t.mutation(api.emailQueue.claim, { limit: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const consumerB = await t.mutation(api.emailQueue.claim, { limit: 1 });

    // Consumer A tries to nack with stale claimId — rejected
    await expect(
      t.mutation(api.emailQueue.nack, {
        messageId: consumerA[0].id,
        claimId: consumerA[0].claimId,
      }),
    ).rejects.toThrow(/Claim expired/);

    // Consumer B's claimId still works
    await t.mutation(api.emailQueue.nack, {
      messageId: consumerB[0].id,
      claimId: consumerB[0].claimId,
    });

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// FIFO ordering
// ---------------------------------------------------------------------------

describe("ordering", () => {
  test("claim returns messages in FIFO order", async () => {
    const t = setup();

    const subjects = ["first", "second", "third"];
    for (const subject of subjects) {
      await t.mutation(api.emailQueue.publish, {
        to: "order@test.com",
        subject,
        body: "b",
      });
    }

    const claimed = await t.mutation(api.emailQueue.claim, { limit: 3 });
    expect(claimed.map((m: any) => m.payload.subject)).toEqual(subjects);
  });
});
