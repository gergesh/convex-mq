/**
 * Example: reactive consumer using ConvexClient (WebSocket).
 *
 * Processes messages as soon as they're published.
 *
 *   CONVEX_URL=https://your-deployment.convex.cloud bun examples/consumer.ts
 */
import { ConvexClient } from "convex/browser";
import { consume } from "../src/client/client.js";
import { api } from "../convex/_generated/api.js";

const client = new ConvexClient(process.env.CONVEX_URL!);

const stop = consume(
  client,
  api.emailQueue,
  async (messages) => {
    for (const msg of messages) {
      console.log(`Sending email to ${msg.payload.to}: ${msg.payload.subject}`);
      // Replace with actual email sending logic:
      // await sendEmail(msg.payload.to, msg.payload.subject, msg.payload.body);
    }
  },
  { batchSize: 5 },
);

process.on("SIGINT", () => {
  console.log("Shutting down consumer...");
  stop();
  process.exit(0);
});

console.log("Consumer started. Waiting for messages...");
