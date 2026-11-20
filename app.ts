// app.ts — the HTTP server: routing, auth, request ids, body handling.
// Routes: /healthz (no auth), /api/v3/* (REST, bearer required),
// /api/graphql (bearer required), /mcp (bearer required), and git smart
// HTTP at /{owner}/{repo}.git/* (no auth required, matching the suite's
// git client, which drives those endpoints without a token). Every reply
// carries an X-GitHub-Request-Id header; errors are JSON with a string
// message; unknown routes are 404; malformed JSON bodies are 400. The
// server never crashes on a bad request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Store } from "./store.ts";
import { handleRest } from "./rest.ts";
import { executeGraphQL } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import { handleInfoRefs, handleReceivePack, handleUploadPack } from "./git-http.ts";

const MAX_BODY = 256 * 1024 * 1024;

export function createAppServer(store: Store): Server {
  let requestSeq = 0;

  const server = createServer((req, res) => {
    requestSeq += 1;
    const requestId = `req-${requestSeq}`;
    res.setHeader("X-GitHub-Request-Id", requestId);
    void handleRequest(req, res, store, requestId).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Internal Server Error" }));
      }
      console.error("request error:", e instanceof Error ? e.message : String(e));
    });
  });
  return server;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  return m ? m[1].trim() : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(extraHeaders ?? {}) };
  res.writeHead(status, headers);
  res.end(body === null ? "" : JSON.stringify(body));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store, _requestId: string): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  const query = url.searchParams;
  const host = req.headers.host ?? "localhost";

  // /healthz — no auth.
  if (path === "/healthz") {
    if (method !== "GET") return sendJson(res, 404, { message: "Not Found" });
    return sendJson(res, 200, { ok: true });
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
  if (gitMatch) {
    const [, owner, repoName, tail] = gitMatch;
    // Git is served from the canonical token's namespace.
    const ns = store.namespaceFor(store.canonicalToken);
    const repo = owner === ns.ownerLogin ? ns.repos.get(repoName) ?? null : null;
    const isV2 = req.headers["git-protocol"] === "version=2";
    if (tail === "info/refs" && method === "GET") {
      const service = query.get("service") ?? "";
      return handleInfoRefs(req, res, repo, service, isV2);
    }
    if (tail === "git-upload-pack" && method === "POST") {
      const body = await readBody(req);
      return handleUploadPack(req, res, repo, body, isV2);
    }
    if (tail === "git-receive-pack" && method === "POST") {
      const body = await readBody(req);
      return handleReceivePack(req, res, repo, body);
    }
    return sendJson(res, 404, { message: "Not Found" });
  }

  // Everything below needs a bearer token.
  const token = bearerToken(req);
  if (!token) return sendJson(res, 401, { message: "Bad credentials" });
  const ns = store.namespaceFor(token);
  const owner = ns.ownerLogin;

  // REST v3
  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    const segments = path === "/api/v3" || path === "/api/v3/"
      ? []
      : path.slice("/api/v3/".length).split("/").map(decodeURIComponent).filter((s) => s.length > 0);
    let body: unknown = null;
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          return sendJson(res, 400, { message: "Problems parsing JSON" });
        }
      }
    }
    const out = handleRest(method, segments, query, path, host, { store, host }, ns, body);
    if (out.status === 204) {
      res.writeHead(204, out.headers ?? {});
      return res.end();
    }
    return sendJson(res, out.status, out.body, { "X-OAuth-Scopes": "repo, read:org", ...(out.headers ?? {}) });
  }

  // GraphQL
  if (path === "/api/graphql" && method === "POST") {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJson(res, 400, { message: "Problems parsing JSON" });
    }
    const result = executeGraphQL(body, { store, ns, owner });
    return sendJson(res, 200, result);
  }

  // MCP
  if (path === "/mcp" && method === "POST") {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const out = handleMcp(body, { store, ns, owner });
    if (out.status === 202) {
      res.writeHead(202);
      return res.end();
    }
    return sendJson(res, out.status, out.body);
  }

  return sendJson(res, 404, { message: "Not Found" });
}
