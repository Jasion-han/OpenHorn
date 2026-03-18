import { Hono } from "hono";
import {
  createMCPServer,
  deleteMCPServer,
  getMCPServerById,
  getMCPServers,
  testMCPServer,
  updateMCPServer,
} from "../services/mcpService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const mcp = new Hono<UserEnv>();

mcp.use("*", requireUser);

mcp.get("/servers", async (c) => {
  const user = c.get("user");

  const servers = await getMCPServers(user.id);
  return c.json({ servers });
});

mcp.get("/servers/:id", async (c) => {
  const user = c.get("user");

  const serverId = c.req.param("id");
  const server = await getMCPServerById(user.id, serverId);

  if (!server) {
    return c.json({ error: "Server not found" }, 404);
  }

  return c.json({ server });
});

mcp.post("/servers", async (c) => {
  const user = c.get("user");

  try {
    const body = await c.req.json();
    const server = await createMCPServer(user.id, body);
    return c.json({ server }, 201);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to create server",
      },
      400,
    );
  }
});

mcp.put("/servers/:id", async (c) => {
  const user = c.get("user");

  try {
    const serverId = c.req.param("id");
    const body = await c.req.json();

    await updateMCPServer(user.id, serverId, body);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update MCP server";
    const status = message === "MCP Server not found" ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

mcp.delete("/servers/:id", async (c) => {
  const user = c.get("user");

  try {
    const serverId = c.req.param("id");
    await deleteMCPServer(user.id, serverId);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete MCP server";
    const status = message === "MCP Server not found" ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

mcp.post("/servers/:id/test", async (c) => {
  const user = c.get("user");

  const serverId = c.req.param("id");
  const result = await testMCPServer(user.id, serverId);

  return c.json(result);
});

export default mcp;
