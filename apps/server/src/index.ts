import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bootstrapDatabase } from "./db/bootstrap";
import agentRoutes from "./routes/agent";
import attachmentRoutes from "./routes/attachments";
import authRoutes from "./routes/auth";
import channelRoutes from "./routes/channels";
import conversationRoutes from "./routes/conversations";
import mcpRoutes from "./routes/mcp";
import messageRoutes from "./routes/messages";
import credentialRoutes from "./routes/credentials";
import settingsRoutes from "./routes/settings";

await bootstrapDatabase();

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      if (origin === "null") return origin;
      if (origin === "tauri://localhost") return origin;

      try {
        const url = new URL(origin);
        const host = url.hostname;
        if (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "0.0.0.0" ||
          host.endsWith(".localhost")
        ) {
          return origin;
        }
      } catch {
        // ignore
      }

      return null;
    },
    credentials: true,
  }),
);

app.get("/", (c) => c.json({ message: "OpenHorn API", version: "1.0.0" }));

app.route("/auth", authRoutes);
app.route("/channels", channelRoutes);
app.route("/conversations", conversationRoutes);
app.route("/messages", messageRoutes);
app.route("/attachments", attachmentRoutes);
app.route("/agent", agentRoutes);
app.route("/mcp", mcpRoutes);
app.route("/credentials", credentialRoutes);
app.route("/settings", settingsRoutes);

const port = parseInt(process.env.PORT || "3002", 10);

console.log(`Server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 120,
};
