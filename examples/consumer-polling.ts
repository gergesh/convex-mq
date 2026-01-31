/**
 * Example: polling consumer using ConvexHttpClient.
 *
 * Useful in environments without WebSocket support, or when
 * you want to use a deploy key for admin authentication.
 *
 *   CONVEX_URL=https://your-deployment.convex.cloud \
 *   CONVEX_DEPLOY_KEY=prod:your-deploy-key \
 *   bun examples/consumer-polling.ts
 */
import { ConvexHttpClient } from "convex/browser";
import { consumePolling } from "../src/client/client.js";
import { api } from "../convex/_generated/api.js";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

// setAdminAuth authenticates with a deploy key,
// giving full admin access including internal functions.
if (process.env.CONVEX_DEPLOY_KEY) {
  (client as any).setAdminAuth(process.env.CONVEX_DEPLOY_KEY);
}

const controller = consumePolling(
  client,
  api.emailQueue,
  async (messages) => {
    for (const msg of messages) {
      console.log(`Sending email to ${msg.payload.to}: ${msg.payload.subject}`);
      // Replace with actual email sending logic:
      // await sendEmail(msg.payload.to, msg.payload.subject, msg.payload.body);
    }
  },
  { batchSize: 10, pollIntervalMs: 2000 },
);

process.on("SIGINT", () => {
  console.log("Shutting down consumer...");
  controller.abort();
  process.exit(0);
});

console.log("Polling consumer started (every 2s). Waiting for messages...");
