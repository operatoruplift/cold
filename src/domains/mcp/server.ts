#!/usr/bin/env bun
/**
 * COLD as an MCP server over stdio: `bun run mcp`. It opens your files and
 * the app's database the way `bun run ui` does and answers each tool from
 * COLD's own API in this process, so you can drive COLD from Claude or any
 * MCP client. Add it to a client as a command: `bun run --cwd <COLD> mcp`.
 *
 * stdout carries the protocol, so everything COLD logs goes to stderr. An
 * email send started here carries on while the client keeps this server
 * open, and after that whenever COLD runs (it is kept in the database).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

// Before anything else loads: stdout is the protocol's.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

const { APP_ROOT, loadEnvFiles, ROOT } = await import("../config");
const { openDatabase } = await import("../db");
const { seedMessages } = await import("../messages");
const { createApi } = await import("../web/api");
const { callRoutes } = await import("../web/calls");
const { WebContext } = await import("../web/context");
const { leadRoutes } = await import("../web/leads");
const { createColdMcpServer } = await import(".");

loadEnvFiles();
seedMessages();
const db = await openDatabase(path.join(ROOT, ".cold", "cold.db"));
const ctx = new WebContext({ root: ROOT, db });
const api = createApi(ctx, [...leadRoutes(ctx), ...callRoutes(ctx)]);
const version = (JSON.parse(readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";

// An email send goes out at the account's pace: carry it on while this server is open.
setInterval(() => void ctx.sends?.tick().catch((err) => console.error("send:", err)), 5000).unref();

serveStdio(() => createColdMcpServer(api, version), { onerror: (err) => console.error("mcp:", err) });
console.error(`COLD's MCP server is running on stdio (files in ${ROOT}).`);
