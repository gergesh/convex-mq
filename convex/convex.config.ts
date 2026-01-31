import { defineApp } from "convex/server";
import messageQueue from "../src/component/convex.config.js";

const app = defineApp();
app.use(messageQueue, { name: "emailQueue" });
app.use(messageQueue, { name: "taskQueue" });
app.use(messageQueue, { name: "secureQueue" });
export default app;
