// mcp.ts — MCP at /mcp: JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28.
// The six tools act on the same store as REST, so a repository created by
// an agent through MCP is visible to `gh` and to git, and vice versa. The
// tools/list answer is built once at module load, so it is byte-identical
// on every call.

import { Store } from "./store.ts";
import type { Issue, Namespace, PullRequest, Repo } from "./store.ts";
import { issueJson, mergeBase, mergeTrees, prJson } from "./rest.ts";
import { isAncestor } from "./pack.ts";
import { objectId, parseCommit, serializeCommit } from "./gitobj.ts";

export interface McpCtx {
  store: Store;
  ns: Namespace;
  owner: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository for the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The repository name." },
        description: { type: "string", description: "A short description of the repository." },
        private: { type: "boolean", description: "Whether the repository is private." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name, or by full_name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        full_name: { type: "string", description: "The repository full name, owner/repo." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        full_name: { type: "string", description: "The repository full name, owner/repo." },
        title: { type: "string", description: "The issue title." },
        body: { type: "string", description: "The issue body." },
        labels: { type: "array", items: { type: "string" }, description: "Labels to apply." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        full_name: { type: "string", description: "The repository full name, owner/repo." },
        state: { type: "string", description: "Issue state: open, closed or all.", enum: ["open", "closed", "all"] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        full_name: { type: "string", description: "The repository full name, owner/repo." },
        title: { type: "string", description: "The pull request title." },
        head: { type: "string", description: "The head branch name." },
        base: { type: "string", description: "The base branch name." },
        body: { type: "string", description: "The pull request body." },
      },
      required: ["title", "head", "base"],
      additionalProperties: false,
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        full_name: { type: "string", description: "The repository full name, owner/repo." },
        pull_number: { type: "integer", description: "The pull request number." },
      },
      required: ["pull_number"],
      additionalProperties: false,
    },
  },
];

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Store.nodeId("Repository", repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: "User" },
    private: repo.isPrivate,
    description: repo.description,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    default_branch: repo.defaultBranch,
  };
}

function resolveRepo(ctx: McpCtx, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === "string" ? args.owner : "";
  let name = typeof args.repo === "string" ? args.repo : "";
  if (typeof args.full_name === "string") {
    const parts = args.full_name.split("/");
    if (parts.length === 2) {
      owner = parts[0];
      name = parts[1];
    }
  }
  if (!name || owner !== ctx.owner) return null;
  return ctx.ns.repos.get(name) ?? null;
}

function toolResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError };
}

function callTool(ctx: McpCtx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const ns = ctx.ns;
  if (name === "create_repo") {
    const repoName = typeof args.name === "string" ? args.name.trim() : "";
    if (!repoName) return toolResult("name is required", true);
    if (ns.repos.has(repoName)) return toolResult(`repository ${repoName} already exists`, true);
    const repo = store.createRepo(ns, repoName, typeof args.description === "string" ? args.description : "", args.private === true);
    return toolResult(JSON.stringify(repoObject(repo)), false);
  }
  if (name === "get_repo") {
    const repo = resolveRepo(ctx, args);
    if (!repo) return toolResult("repository not found", true);
    return toolResult(JSON.stringify(repoObject(repo)), false);
  }
  if (name === "create_issue") {
    const repo = resolveRepo(ctx, args);
    if (!repo) return toolResult("repository not found", true);
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return toolResult("title is required", true);
    const ts = store.now();
    const issue: Issue = {
      id: ns.nextObjectId++,
      number: repo.nextNumber++,
      title,
      body: typeof args.body === "string" ? args.body : "",
      state: "open",
      labels: Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === "string") : [],
      user: ctx.owner,
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return toolResult(JSON.stringify(issueJson(repo, issue)), false);
  }
  if (name === "list_issues") {
    const repo = resolveRepo(ctx, args);
    if (!repo) return toolResult("repository not found", true);
    const state = typeof args.state === "string" ? args.state : "open";
    let list = [...repo.issues.values()];
    if (state !== "all") list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    return toolResult(JSON.stringify(list.map((i) => issueJson(repo, i, repo.pulls.get(i.number)))), false);
  }
  if (name === "create_pull_request") {
    const repo = resolveRepo(ctx, args);
    if (!repo) return toolResult("repository not found", true);
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const head = typeof args.head === "string" ? args.head : "";
    const base = typeof args.base === "string" ? args.base : "";
    if (!title || !head || !base) return toolResult("title, head and base are required", true);
    const headRefName = head.includes(":") ? head.split(":").slice(1).join(":") : head;
    const headSha = repo.refs.get(`refs/heads/${headRefName}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return toolResult("head or base ref does not exist", true);
    const ts = store.now();
    const pr: PullRequest = {
      id: ns.nextObjectId++,
      number: repo.nextNumber++,
      title,
      body: typeof args.body === "string" ? args.body : "",
      state: "open",
      headRef: headRefName,
      headSha,
      baseRef: base,
      baseSha,
      merged: false,
      mergeable: !isAncestor(repo, headSha, baseSha),
      mergeCommitSha: null,
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      mergedAt: null,
    };
    repo.pulls.set(pr.number, pr);
    return toolResult(JSON.stringify(prJson(repo, pr)), false);
  }
  if (name === "merge_pull_request") {
    const repo = resolveRepo(ctx, args);
    if (!repo) return toolResult("repository not found", true);
    const num = Number(args.pull_number);
    const pr = repo.pulls.get(num);
    if (!pr) return toolResult("pull request not found", true);
    if (pr.merged) return toolResult("pull request has already been merged", true);
    if (pr.state !== "open") return toolResult("pull request is closed", true);
    const baseRefName = `refs/heads/${pr.baseRef}`;
    const baseTip = repo.refs.get(baseRefName);
    const headObj = repo.objects.get(pr.headSha);
    if (!baseTip || !headObj || headObj.type !== "commit") return toolResult("cannot merge: missing commit", true);
    let mergeSha: string;
    if (isAncestor(repo, baseTip, pr.headSha)) {
      mergeSha = pr.headSha;
      repo.refs.set(baseRefName, pr.headSha);
    } else {
      const base = mergeBase(repo, baseTip, pr.headSha);
      if (!base) return toolResult("cannot merge: no merge base", true);
      const merged = mergeTrees(repo, baseTip, pr.headSha, base);
      if (!merged) return toolResult("cannot merge: merge conflict", true);
      const ts = store.now();
      const unix = Math.floor(Date.parse(ts) / 1000);
      const who = `${ctx.owner} <${ctx.owner}@users.noreply.github.com> ${unix} +0000`;
      const data = serializeCommit({
        tree: merged.treeOid,
        parents: [baseTip, pr.headSha],
        author: who,
        committer: who,
        message: `Merge pull request #${pr.number} from ${ctx.owner}/${pr.headRef}`,
        extra: [],
      });
      mergeSha = objectId("commit", data);
      repo.objects.set(mergeSha, { type: "commit", data });
      repo.refs.set(baseRefName, mergeSha);
    }
    pr.merged = true;
    pr.mergeCommitSha = mergeSha;
    pr.mergedAt = store.now();
    pr.state = "closed";
    pr.closedAt = pr.mergedAt;
    pr.updatedAt = pr.mergedAt;
    return toolResult(JSON.stringify({ sha: mergeSha, merged: true, message: "Pull request successfully merged" }), false);
  }
  return toolResult(`unknown tool ${name}`, true);
}

// ------------------------------------------------------------------ endpoint

export interface McpResponse {
  status: number;
  body: unknown; // string for empty, otherwise JSON
}

export function handleMcp(body: unknown, ctx: McpCtx): McpResponse {
  if (body === null || typeof body !== "object") {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } };
  }
  const requests = Array.isArray(body) ? body : [body];
  const responses: Record<string, unknown>[] = [];
  for (const req of requests) {
    const r = (req ?? {}) as Record<string, unknown>;
    const method = typeof r.method === "string" ? r.method : "";
    const id = r.id === undefined ? null : r.id;
    const params = (r.params ?? {}) as Record<string, unknown>;
    if (method.startsWith("notifications/")) continue; // no response
    if (method === "server/discover") {
      // The 2026-07-28 revision's discovery answer carries the server
      // identity as well as the versions it speaks.
      responses.push({
        jsonrpc: "2.0",
        id,
        result: {
          name: "github-core-clone",
          version: "1.0.0",
          protocolVersion: "2026-07-28",
          supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
          serverInfo: { name: "github-core-clone", version: "1.0.0" },
          capabilities: { tools: {}, logging: {} },
        },
      });
      continue;
    }
    if (method === "initialize") {
      responses.push({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
          capabilities: { tools: {}, logging: {} },
          serverInfo: { name: "github-core-clone", version: "1.0.0" },
        },
      });
      continue;
    }
    if (method === "ping") {
      responses.push({ jsonrpc: "2.0", id, result: {} });
      continue;
    }
    if (method === "tools/list") {
      responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      continue;
    }
    if (method === "tools/call") {
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === toolName)) {
        responses.push({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
        continue;
      }
      const result = callTool(ctx, toolName, args);
      responses.push({ jsonrpc: "2.0", id, result });
      continue;
    }
    responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
  if (responses.length === 0) return { status: 202, body: "" };
  const out = Array.isArray(body) ? responses : responses[0];
  return { status: 200, body: out };
}
