// rest.ts — REST v3: repositories, branches, commits, contents, issues,
// comments, labels and pull requests. Shapes follow GitHub's API: every
// reply is JSON with an X-GitHub-Request-Id header, errors carry a string
// message, unknown routes are 404 and malformed JSON is 400.

import { objectId, parseCommit, parseTree, serializeCommit, serializeTree, ZERO_OID, isHexOid, type TreeEntry } from "./gitobj.ts";
import { isAncestor, walkCommits } from "./pack.ts";
import { readTreeAt } from "./git-http.ts";
import { Store } from "./store.ts";
import type { Issue, Label, PullRequest, Repo } from "./store.ts";

export interface RestCtx {
  store: Store;
  host: string;
}

interface Resp {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): Resp => ({ status, body, headers });
const err = (status: number, message: string): Resp => json(status, { message, documentation_url: "https://docs.github.com/rest" });

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: Store.nodeId("User", id),
    avatar_url: "",
    gravatar_id: "",
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: "User",
    site_admin: false,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === "open").length +
    [...repo.pulls.values()].filter((p) => p.state === "open").length;
  return {
    id: repo.id,
    node_id: Store.nodeId("Repository", repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, 1),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? "private" : "public",
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Store.nodeId("Label", repo.id, label.id),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: true,
  };
}

export function issueJson(repo: Repo, issue: Issue, pr?: PullRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: issue.id,
    node_id: Store.nodeId("Issue", repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels
      .map((n) => repo.labels.get(n.toLowerCase()))
      .filter((l): l is Label => !!l)
      .map((l) => labelJson(repo, l)),
    user: userJson(issue.user, 1),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: "OWNER",
    state_reason: issue.state === "closed" ? "completed" : null,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
  };
  if (pr) {
    out.pull_request = {
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
      diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
      patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    };
  }
  return out;
}

function commentJson(repo: Repo, issue: Issue, c: Issue["comments"][number]): Record<string, unknown> {
  return {
    id: c.id,
    node_id: Store.nodeId("IssueComment", repo.id, issue.number, c.id),
    body: c.body,
    user: userJson(c.user, 1),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headRef = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseRef = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const commits = headRef ? walkCommits(repo, headRef, new Set(baseRef ? [baseRef] : [])).size : 0;
  const files = diffFiles(repo, pr);
  return {
    id: pr.id,
    node_id: Store.nodeId("PullRequest", repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userJson(repo.owner, 1),
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    draft: false,
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, user: userJson(repo.owner, 1), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha, user: userJson(repo.owner, 1), repo: repoJson(repo) },
    merged: pr.merged,
    mergeable: mergeState(repo, pr) === "MERGEABLE",
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    comments: 0,
    review_comments: 0,
    commits,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    changed_files: files.length,
  };
}

function parsePerson(raw: string): { name: string; email: string; date: string } {
  const m = raw.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: raw, email: "", date: "" };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== "commit") return null;
  const c = parseCommit(obj.data);
  const author = parsePerson(c.author);
  const committer = parsePerson(c.committer);
  const authorUser = author.name === repo.owner ? userJson(repo.owner, 1) : null;
  return {
    sha: oid,
    node_id: Store.nodeId("Commit", repo.id, oid),
    commit: {
      author,
      committer,
      message: c.message,
      tree: { sha: c.tree, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
    },
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: authorUser,
    committer: authorUser,
    parents: c.parents.map((p) => ({ sha: p, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${p}` })),
  };
}

// --------------------------------------------------------------- pagination

function paginate<T>(items: T[], query: URLSearchParams, path: string, host: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get("per_page") ?? "30", 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (totalPages > 1) {
    const links: string[] = [];
    const q = new URLSearchParams(query);
    if (pageNum < totalPages) {
      q.set("page", String(pageNum + 1));
      links.push(`<http://${host}${path}?${q}>; rel="next"`);
    }
    if (pageNum > 1) {
      q.set("page", String(pageNum - 1));
      links.push(`<http://${host}${path}?${q}>; rel="prev"`);
    }
    q.set("page", String(totalPages));
    links.push(`<http://${host}${path}?${q}>; rel="last"`);
    q.set("page", "1");
    links.push(`<http://${host}${path}?${q}>; rel="first"`);
    headers.Link = links.join(", ");
  }
  return { page, headers };
}

// ------------------------------------------------------------ tree building

function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, TreeEntry>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== "tree") return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === "40000") flattenTree(repo, e.oid, path, out);
    else out.set(path, e);
  }
}

function buildTree(repo: Repo, flat: Map<string, TreeEntry>): string {
  // Group paths by their first segment, recurse, then serialise.
  const build = (paths: string[], prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, string[]>();
    for (const p of paths) {
      const rest = prefix ? p.slice(prefix.length + 1) : p;
      const slash = rest.indexOf("/");
      if (slash < 0) {
        const e = flat.get(p)!;
        entries.push({ mode: e.mode, name: rest, oid: e.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir)!.push(p);
      }
    }
    for (const [dir, sub] of [...dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: "40000", name: dir, oid: build(sub, prefix ? `${prefix}/${dir}` : dir) });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const data = serializeTree(entries);
    const oid = objectId("tree", data);
    repo.objects.set(oid, { type: "tree", data });
    return oid;
  };
  return build([...flat.keys()].sort(), "");
}

function makeCommit(
  repo: Repo,
  store: Store,
  treeOid: string,
  parents: string[],
  message: string,
  authorName: string,
): string {
  const iso = store.now();
  const unix = Math.floor(Date.parse(iso) / 1000);
  const who = `${authorName} <${authorName}@users.noreply.github.com> ${unix} +0000`;
  const data = serializeCommit({ tree: treeOid, parents, author: who, committer: who, message, extra: [] });
  const oid = objectId("commit", data);
  repo.objects.set(oid, { type: "commit", data });
  return oid;
}

// ------------------------------------------------------------------ diffing

interface FileDiff {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified";
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch?: string;
}

function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > 0 && a[a.length - 1] === "") a.pop();
  if (b.length > 0 && b[b.length - 1] === "") b.pop();
  // LCS by dynamic programming (files in tests are small).
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: b.length - common, deletions: a.length - common };
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0);
}

export function diffFiles(repo: Repo, pr: PullRequest): FileDiff[] {
  const baseFlat = new Map<string, TreeEntry>();
  const headFlat = new Map<string, TreeEntry>();
  const baseObj = repo.objects.get(pr.baseSha);
  if (baseObj && baseObj.type === "commit") flattenTree(repo, parseCommit(baseObj.data).tree, "", baseFlat);
  const headObj = repo.objects.get(pr.headSha);
  if (headObj && headObj.type === "commit") flattenTree(repo, parseCommit(headObj.data).tree, "", headFlat);
  const out: FileDiff[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const baseUrl = `https://github.com/${repo.owner}/${repo.name}`;
    if (b && !h) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const oldText = oldData.toString("utf8");
      const deletions = isBinary(oldData) ? 0 : oldText.split("\n").filter((l) => l.length > 0).length;
      out.push({
        sha: b.oid,
        filename: path,
        status: "removed",
        additions: 0,
        deletions,
        changes: deletions,
        blob_url: `${baseUrl}/blob/${pr.baseSha}/${path}`,
        raw_url: `${baseUrl}/raw/${pr.baseSha}/${path}`,
        contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${pr.baseSha}`,
      });
      continue;
    }
    if (!b && h) {
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = isBinary(newData) ? 0 : newData.toString("utf8").split("\n").filter((l) => l.length > 0).length;
      out.push({
        sha: h.oid,
        filename: path,
        status: "added",
        additions,
        deletions: 0,
        changes: additions,
        blob_url: `${baseUrl}/blob/${pr.headSha}/${path}`,
        raw_url: `${baseUrl}/raw/${pr.headSha}/${path}`,
        contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${pr.headSha}`,
        patch: isBinary(newData)
          ? undefined
          : `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${additions} @@\n` +
            newData.toString("utf8").split("\n").map((l) => `+${l}`).join("\n"),
      });
      continue;
    }
    if (b && h && b.oid !== h.oid) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const counts = isBinary(oldData) || isBinary(newData)
        ? { additions: 0, deletions: 0 }
        : lineCounts(oldData.toString("utf8"), newData.toString("utf8"));
      out.push({
        sha: h.oid,
        filename: path,
        status: "modified",
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        blob_url: `${baseUrl}/blob/${pr.headSha}/${path}`,
        raw_url: `${baseUrl}/raw/${pr.headSha}/${path}`,
        contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${pr.headSha}`,
        patch: isBinary(oldData) || isBinary(newData)
          ? undefined
          : `--- a/${path}\n+++ b/${path}\n@@ -1,${oldData.toString("utf8").split("\n").length} +1,${newData.toString("utf8").split("\n").length} @@\n` +
            oldData.toString("utf8").split("\n").map((l) => `-${l}`).join("\n") +
            "\n" +
            newData.toString("utf8").split("\n").map((l) => `+${l}`).join("\n"),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ merging

export type MergeState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** The nearest common ancestor of two commits, or null if they share none. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.shift()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === "commit") {
      for (const p of parseCommit(obj.data).parents) queueA.push(p);
    }
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === "commit") {
      for (const p of parseCommit(obj.data).parents) queueB.push(p);
    }
  }
  return null;
}

/**
 * Three-way merge of the base branch tip and the head tip against their
 * merge base. Returns the merged tree oid, or null when both sides changed
 * the same path differently (a real conflict).
 */
export function mergeTrees(repo: Repo, baseTip: string, headTip: string, base: string): { treeOid: string } | null {
  const treeOf = (tip: string): string | null => {
    const obj = repo.objects.get(tip);
    return obj && obj.type === "commit" ? parseCommit(obj.data).tree : null;
  };
  const flatBase = new Map<string, TreeEntry>();
  const flatOurs = new Map<string, TreeEntry>();
  const flatTheirs = new Map<string, TreeEntry>();
  const tBase = treeOf(base);
  const tOurs = treeOf(baseTip);
  const tTheirs = treeOf(headTip);
  if (tBase) flattenTree(repo, tBase, "", flatBase);
  if (tOurs) flattenTree(repo, tOurs, "", flatOurs);
  if (tTheirs) flattenTree(repo, tTheirs, "", flatTheirs);
  const merged = new Map<string, TreeEntry>();
  const paths = new Set([...flatBase.keys(), ...flatOurs.keys(), ...flatTheirs.keys()]);
  for (const path of paths) {
    const b = flatBase.get(path);
    const o = flatOurs.get(path);
    const t = flatTheirs.get(path);
    if (o?.oid === t?.oid) {
      if (o) merged.set(path, o);
    } else if (o?.oid === b?.oid) {
      if (t) merged.set(path, t);
    } else if (t?.oid === b?.oid) {
      if (o) merged.set(path, o);
    } else {
      return null; // both sides changed this path differently
    }
  }
  return { treeOid: buildTree(repo, merged) };
}

/** Whether a pull request can be merged right now. */
export function mergeState(repo: Repo, pr: PullRequest): MergeState {
  if (pr.merged || pr.state !== "open") return "UNKNOWN";
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return "UNKNOWN";
  if (isAncestor(repo, baseTip, pr.headSha)) return "MERGEABLE";
  const base = mergeBase(repo, baseTip, pr.headSha);
  if (!base) return "UNKNOWN";
  const merged = mergeTrees(repo, baseTip, pr.headSha, base);
  return merged ? "MERGEABLE" : "CONFLICTING";
}

// ------------------------------------------------------------------- router

export function handleRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  path: string,
  host: string,
  ctx: RestCtx,
  ns: ReturnType<Store["namespaceFor"]>,
  body: unknown,
): Resp {
  const store = ctx.store;
  const owner = ns.ownerLogin;

  const needRepo = (o: string, r: string): Repo | Resp => {
    if (o !== owner) return err(404, "Not Found");
    const repo = ns.repos.get(r);
    if (!repo) return err(404, "Not Found");
    return repo;
  };
  const isResp = (x: Repo | Resp): x is Resp => (x as Resp).status !== undefined && (x as Resp).body !== undefined;

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== "GET") return err(404, "Not Found");
    return json(200, {
      current_user_url: "https://api.github.com/user",
      repository_url: "https://api.github.com/repos/{owner}/{repo}",
    });
  }

  // GET /api/v3/meta
  if (segments[0] === "meta" && segments.length === 1) {
    if (method !== "GET") return err(404, "Not Found");
    return json(200, {
      verifiable_password_authentication: true,
      github_services_sha: "0000000000000000000000000000000000000000",
      hooks: ["127.0.0.1"],
      git: ["127.0.0.1"],
      imported: [],
      pages: [],
      installed_version: "1.0.0",
    });
  }

  // GET /api/v3/user
  if (segments[0] === "user" && segments.length === 1) {
    if (method !== "GET") return err(404, "Not Found");
    return json(200, userJson(owner, 1));
  }

  // /api/v3/user/repos
  if (segments[0] === "user" && segments[1] === "repos") {
    if (method === "GET") {
      const repos = [...ns.repos.values()].map(repoJson);
      const p = paginate(repos, query, path, host);
      return json(200, p.page, p.headers);
    }
    if (method === "POST") {
      const b = (body ?? {}) as Record<string, unknown>;
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name || /[\s/]/.test(name)) return err(422, "Validation Failed: name is invalid");
      if (ns.repos.has(name)) return err(422, "Validation Failed: name already exists on this account");
      const repo = store.createRepo(ns, name, typeof b.description === "string" ? b.description : "", b.private === true);
      return json(201, repoJson(repo));
    }
    return err(404, "Not Found");
  }

  // /api/v3/repos/...
  if (segments[0] === "repos") {
    const [, o, r, ...rest] = segments;
    if (!o || !r) return err(404, "Not Found");
    // DELETE /repos/{o}/{r}
    if (rest.length === 0 && method === "DELETE") {
      const repo = needRepo(o, r);
      if (isResp(repo)) return repo;
      ns.repos.delete(r);
      return json(204, null);
    }
    // GET/PATCH /repos/{o}/{r}
    if (rest.length === 0) {
      const repo = needRepo(o, r);
      if (isResp(repo)) return repo;
      if (method === "GET") return json(200, repoJson(repo));
      if (method === "PATCH") {
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.description === "string") repo.description = b.description;
        if (typeof b.name === "string" && b.name !== r) {
          if (ns.repos.has(b.name)) return err(422, "Validation Failed: name already exists on this account");
          ns.repos.delete(r);
          repo.name = b.name;
          ns.repos.set(b.name, repo);
        }
        repo.updatedAt = store.now();
        return json(200, repoJson(repo));
      }
      return err(404, "Not Found");
    }

    const repo = needRepo(o, r);
    if (isResp(repo)) return repo;

    // git refs: POST /git/refs creates a ref; GET/DELETE/PATCH /git/ref(s)/...
    if (rest[0] === "git" && (rest[1] === "refs" || rest[1] === "ref")) {
      const refJson = (fullRef: string, sha: string): Record<string, unknown> => {
        const obj = repo.objects.get(sha);
        return {
          ref: fullRef,
          node_id: Store.nodeId("Ref", repo.id, fullRef),
          url: `https://api.github.com/repos/${owner}/${r}/git/refs/${fullRef.slice(5)}`,
          object: { sha, type: obj?.type ?? "commit", url: `https://api.github.com/repos/${owner}/${r}/git/commits/${sha}` },
        };
      };
      if (method === "POST" && rest.length === 2) {
        const b = (body ?? {}) as Record<string, unknown>;
        const ref = typeof b.ref === "string" ? b.ref : "";
        const sha = typeof b.sha === "string" ? b.sha : "";
        if (!ref.startsWith("refs/") || !isHexOid(sha)) return err(422, "Validation Failed: ref and sha are required");
        if (repo.refs.has(ref)) return err(422, "Validation Failed: ref already exists");
        const obj = repo.objects.get(sha);
        if (!obj || (obj.type !== "commit" && obj.type !== "tag")) return err(422, "Validation Failed: sha does not exist");
        repo.refs.set(ref, sha);
        return json(201, refJson(ref, sha));
      }
      if (rest.length >= 3) {
        const fullRef = `refs/${rest.slice(2).map(decodeURIComponent).join("/")}`;
        if (method === "GET") {
          const sha = repo.refs.get(fullRef);
          if (!sha) return err(404, "Not Found");
          return json(200, refJson(fullRef, sha));
        }
        if (method === "DELETE") {
          if (!repo.refs.has(fullRef)) return err(404, "Not Found");
          repo.refs.delete(fullRef);
          return json(204, null);
        }
        if (method === "PATCH") {
          const b = (body ?? {}) as Record<string, unknown>;
          const sha = typeof b.sha === "string" ? b.sha : "";
          const force = b.force === true;
          const current = repo.refs.get(fullRef);
          if (!current) return err(404, "Not Found");
          if (!isHexOid(sha) || !repo.objects.has(sha)) return err(422, "Validation Failed: sha does not exist");
          if (!force && !isAncestor(repo, current, sha)) return err(422, "Validation Failed: update is not a fast-forward");
          repo.refs.set(fullRef, sha);
          return json(200, refJson(fullRef, sha));
        }
      }
      return err(404, "Not Found");
    }

    // branches
    if (rest[0] === "branches") {
      if (rest.length === 1 && method === "GET") {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith("refs/heads/"))
          .map((ref) => ref.slice(11))
          .sort()
          .map((name) => ({
            name,
            commit: { sha: repo.refs.get(`refs/heads/${name}`), url: `https://api.github.com/repos/${owner}/${r}/commits/${repo.refs.get(`refs/heads/${name}`)}` },
            protected: false,
          }));
        const p = paginate(branches, query, path, host);
        return json(200, p.page, p.headers);
      }
      if (rest.length === 2 && method === "GET") {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) return err(404, "Not Found");
        return json(200, {
          name: rest[1],
          commit: { sha, url: `https://api.github.com/repos/${owner}/${r}/commits/${sha}` },
          protected: false,
        });
      }
      return err(404, "Not Found");
    }

    // commits
    if (rest[0] === "commits") {
      if (rest.length === 1 && method === "GET") {
        const shaParam = query.get("sha");
        const tip = shaParam
          ? repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : null)
          : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return json(200, []);
        const oids = [...walkCommits(repo, tip, new Set())];
        const list = oids.map((oid) => commitJson(repo, oid)).filter((c): c is Record<string, unknown> => !!c);
        const p = paginate(list, query, path, host);
        return json(200, p.page, p.headers);
      }
      if (rest.length === 2 && method === "GET") {
        const c = commitJson(repo, rest[1]);
        if (!c) return err(404, "Not Found");
        return json(200, c);
      }
      return err(404, "Not Found");
    }

    // contents
    if (rest[0] === "contents") {
      const filePath = rest.slice(1).map(decodeURIComponent).join("/");
      const refName = query.get("ref") ?? (body as Record<string, unknown> | null)?.branch as string | undefined;
      const branch = typeof refName === "string" && refName ? refName : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (method === "GET") {
        if (!tip) return err(404, "Not Found");
        const found = readTreeAt(repo, tip, filePath);
        if (!found.type) return err(404, "Not Found");
        if (found.type === "blob") {
          const data = repo.objects.get(found.oid!)!.data;
          return json(200, {
            type: "file",
            encoding: "base64",
            size: data.length,
            name: filePath.split("/").pop(),
            path: filePath,
            content: data.toString("base64"),
            sha: found.oid,
            url: `https://api.github.com/repos/${owner}/${r}/contents/${filePath}`,
            git_url: `https://api.github.com/repos/${owner}/${r}/git/blobs/${found.oid}`,
            html_url: `https://github.com/${owner}/${r}/blob/${branch}/${filePath}`,
            download_url: `https://raw.githubusercontent.com/${owner}/${r}/${branch}/${filePath}`,
            _links: { git: `https://api.github.com/repos/${owner}/${r}/git/blobs/${found.oid}`, self: `https://api.github.com/repos/${owner}/${r}/contents/${filePath}`, html: `https://github.com/${owner}/${r}/blob/${branch}/${filePath}` },
          });
        }
        const entries = (found.entry ?? []).map((e) => {
          const isDir = e.mode === "40000";
          const child = repo.objects.get(e.oid);
          return {
            type: isDir ? "dir" : "file",
            size: isDir ? 0 : (child?.data.length ?? 0),
            name: e.name,
            path: filePath ? `${filePath}/${e.name}` : e.name,
            sha: e.oid,
            url: `https://api.github.com/repos/${owner}/${r}/contents/${filePath ? `${filePath}/` : ""}${e.name}`,
            git_url: `https://api.github.com/repos/${owner}/${r}/git/${isDir ? "trees" : "blobs"}/${e.oid}`,
            html_url: `https://github.com/${owner}/${r}/${isDir ? "tree" : "blob"}/${branch}/${filePath ? `${filePath}/` : ""}${e.name}`,
            download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${r}/${branch}/${filePath ? `${filePath}/` : ""}${e.name}`,
          };
        });
        return json(200, entries);
      }
      if (method === "PUT") {
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.message !== "string" || typeof b.content !== "string") return err(422, "Validation Failed: message and content are required");
        let content: Buffer;
        try {
          content = Buffer.from(b.content, "base64");
        } catch {
          return err(422, "Validation Failed: content is not valid base64");
        }
        const branchRef = `refs/heads/${branch}`;
        let currentTip = repo.refs.get(branchRef);
        if (!currentTip) {
          // A contents write to a branch that does not exist yet starts
          // that branch from the default branch tip (or from nothing when
          // the repository is still empty).
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultTip) {
            repo.refs.set(branchRef, defaultTip);
            currentTip = defaultTip;
          }
        }
        const flat = new Map<string, TreeEntry>();
        if (currentTip) {
          const commit = repo.objects.get(currentTip);
          if (commit && commit.type === "commit") flattenTree(repo, parseCommit(commit.data).tree, "", flat);
        }
        const existing = flat.get(filePath);
        const isUpdate = !!existing;
        if (isUpdate) {
          if (typeof b.sha !== "string" || b.sha !== existing!.oid) return err(409, "sha does not match the current file");
        }
        const blobOid = objectId("blob", content);
        repo.objects.set(blobOid, { type: "blob", data: content });
        flat.set(filePath, { mode: "100644", name: filePath.split("/").pop()!, oid: blobOid });
        const treeOid = buildTree(repo, flat);
        const commitOid = makeCommit(repo, store, treeOid, currentTip ? [currentTip] : [], b.message, owner);
        repo.refs.set(branchRef, commitOid);
        repo.updatedAt = store.now();
        repo.pushedAt = repo.updatedAt;
        return json(isUpdate ? 200 : 201, {
          content: {
            type: "file",
            encoding: "base64",
            size: content.length,
            name: filePath.split("/").pop(),
            path: filePath,
            content: content.toString("base64"),
            sha: blobOid,
            url: `https://api.github.com/repos/${owner}/${r}/contents/${filePath}`,
          },
          commit: commitJson(repo, commitOid),
        });
      }
      if (method === "DELETE") {
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.message !== "string" || typeof b.sha !== "string") return err(422, "Validation Failed: message and sha are required");
        const branchRef = `refs/heads/${branch}`;
        const currentTip = repo.refs.get(branchRef);
        if (!currentTip) return err(404, "Not Found");
        const flat = new Map<string, TreeEntry>();
        const commit = repo.objects.get(currentTip);
        if (commit && commit.type === "commit") flattenTree(repo, parseCommit(commit.data).tree, "", flat);
        const existing = flat.get(filePath);
        if (!existing) return err(404, "Not Found");
        if (b.sha !== existing.oid) return err(409, "sha does not match the current file");
        flat.delete(filePath);
        const treeOid = buildTree(repo, flat);
        const commitOid = makeCommit(repo, store, treeOid, [currentTip], b.message, owner);
        repo.refs.set(branchRef, commitOid);
        repo.updatedAt = store.now();
        return json(200, { commit: commitJson(repo, commitOid) });
      }
      return err(404, "Not Found");
    }

    // labels
    if (rest[0] === "labels") {
      if (method === "GET" && rest.length === 1) {
        const labels = [...repo.labels.values()].map((l) => labelJson(repo, l));
        const p = paginate(labels, query, path, host);
        return json(200, p.page, p.headers);
      }
      if (method === "POST" && rest.length === 1) {
        const b = (body ?? {}) as Record<string, unknown>;
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (!name) return err(422, "Validation Failed: name is required");
        if (repo.labels.has(name.toLowerCase())) return err(422, "Validation Failed: label already exists");
        const label: Label = {
          id: repo.nextLabelId++,
          name,
          color: typeof b.color === "string" ? b.color.replace(/^#/, "") : "ededed",
          description: typeof b.description === "string" ? b.description : "",
        };
        repo.labels.set(name.toLowerCase(), label);
        return json(201, labelJson(repo, label));
      }
      return err(404, "Not Found");
    }

    // issues
    if (rest[0] === "issues") {
      if (rest.length === 1 && method === "GET") {
        const state = query.get("state") ?? "open";
        const sort = query.get("sort") ?? "created";
        const direction = query.get("direction") ?? "desc";
        let list = [...repo.issues.values()];
        if (state !== "all") list = list.filter((i) => i.state === state);
        list.sort((a, b) => {
          const cmp = sort === "updated"
            ? a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number
            : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
          return direction === "asc" ? cmp : -cmp;
        });
        const p = paginate(list.map((i) => issueJson(repo, i, repo.pulls.get(i.number))), query, path, host);
        return json(200, p.page, p.headers);
      }
      if (rest.length === 1 && method === "POST") {
        const b = (body ?? {}) as Record<string, unknown>;
        const title = typeof b.title === "string" ? b.title.trim() : "";
        if (!title) return err(422, "Validation Failed: title is required");
        const labels = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === "string") : [];
        for (const l of labels) {
          if (!repo.labels.has(l.toLowerCase())) return err(422, `Validation Failed: label "${l}" does not exist`);
        }
        const ts = store.now();
        const issue: Issue = {
          id: ns.nextObjectId++,
          number: repo.nextNumber++,
          title,
          body: typeof b.body === "string" ? b.body : "",
          state: "open",
          labels,
          user: owner,
          createdAt: ts,
          updatedAt: ts,
          closedAt: null,
          comments: [],
        };
        repo.issues.set(issue.number, issue);
        return json(201, issueJson(repo, issue));
      }
      const num = parseInt(rest[1] ?? "", 10);
      if (!Number.isFinite(num)) return err(404, "Not Found");
      const issue = repo.issues.get(num);
      const prAsIssue = repo.pulls.get(num);
      if (rest.length === 2 && method === "GET") {
        if (issue) return json(200, issueJson(repo, issue, prAsIssue));
        if (prAsIssue) {
          // A pull request also answers as an issue.
          const asIssue: Issue = {
            id: prAsIssue.id,
            number: prAsIssue.number,
            title: prAsIssue.title,
            body: prAsIssue.body,
            state: prAsIssue.state,
            labels: [],
            user: owner,
            createdAt: prAsIssue.createdAt,
            updatedAt: prAsIssue.updatedAt,
            closedAt: prAsIssue.closedAt,
            comments: [],
          };
          return json(200, issueJson(repo, asIssue, prAsIssue));
        }
        return err(404, "Not Found");
      }
      if (rest.length === 2 && method === "PATCH") {
        if (!issue) return err(404, "Not Found");
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.title === "string") issue.title = b.title;
        if (typeof b.body === "string") issue.body = b.body;
        if (b.state === "closed" && issue.state !== "closed") {
          issue.state = "closed";
          issue.closedAt = store.now();
        } else if (b.state === "open" && issue.state !== "open") {
          issue.state = "open";
          issue.closedAt = null;
        }
        if (Array.isArray(b.labels)) {
          const labels = b.labels.filter((l): l is string => typeof l === "string");
          for (const l of labels) {
            if (!repo.labels.has(l.toLowerCase())) return err(422, `Validation Failed: label "${l}" does not exist`);
          }
          issue.labels = labels;
        }
        issue.updatedAt = store.now();
        return json(200, issueJson(repo, issue));
      }
      if (rest.length === 3 && rest[2] === "comments") {
        if (!issue) return err(404, "Not Found");
        if (method === "GET") {
          const p = paginate(issue.comments.map((c) => commentJson(repo, issue, c)), query, path, host);
          return json(200, p.page, p.headers);
        }
        if (method === "POST") {
          const b = (body ?? {}) as Record<string, unknown>;
          if (typeof b.body !== "string" || !b.body.trim()) return err(422, "Validation Failed: body is required");
          const ts = store.now();
          const comment = { id: repo.nextCommentId++, body: b.body, user: owner, createdAt: ts, updatedAt: ts };
          issue.comments.push(comment);
          issue.updatedAt = store.now();
          return json(201, commentJson(repo, issue, comment));
        }
      }
      return err(404, "Not Found");
    }

    // pulls
    if (rest[0] === "pulls") {
      if (rest.length === 1 && method === "GET") {
        const state = query.get("state") ?? "open";
        const sort = query.get("sort") ?? "created";
        const direction = query.get("direction") ?? "desc";
        let list = [...repo.pulls.values()];
        if (state !== "all") list = list.filter((p) => p.state === state);
        list.sort((a, b) => {
          const cmp = sort === "updated"
            ? a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number
            : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
          return direction === "asc" ? cmp : -cmp;
        });
        const p = paginate(list.map((pr) => prJson(repo, pr)), query, path, host);
        return json(200, p.page, p.headers);
      }
      if (rest.length === 1 && method === "POST") {
        const b = (body ?? {}) as Record<string, unknown>;
        const title = typeof b.title === "string" ? b.title.trim() : "";
        const head = typeof b.head === "string" ? b.head : "";
        const base = typeof b.base === "string" ? b.base : "";
        if (!title || !head || !base) return err(422, "Validation Failed: title, head and base are required");
        const headRefName = head.includes(":") ? head.split(":").slice(1).join(":") : head;
        const headSha = repo.refs.get(`refs/heads/${headRefName}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) return err(422, "Validation Failed: head or base ref does not exist");
        const ts = store.now();
        const pr: PullRequest = {
          id: ns.nextObjectId++,
          number: repo.nextNumber++,
          title,
          body: typeof b.body === "string" ? b.body : "",
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
        return json(201, prJson(repo, pr));
      }
      const num = parseInt(rest[1] ?? "", 10);
      if (!Number.isFinite(num)) return err(404, "Not Found");
      const pr = repo.pulls.get(num);
      if (!pr) return err(404, "Not Found");
      if (rest.length === 2 && method === "GET") return json(200, prJson(repo, pr));
      if (rest.length === 2 && method === "PATCH") {
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.title === "string") pr.title = b.title;
        if (typeof b.body === "string") pr.body = b.body;
        if (b.state === "closed" && pr.state !== "closed") {
          pr.state = "closed";
          pr.closedAt = store.now();
        } else if (b.state === "open" && pr.state !== "open") {
          pr.state = "open";
          pr.closedAt = null;
        }
        pr.updatedAt = store.now();
        return json(200, prJson(repo, pr));
      }
      if (rest.length === 3 && rest[2] === "files" && method === "GET") {
        return json(200, diffFiles(repo, pr));
      }
      if (rest.length === 3 && rest[2] === "merge" && method === "PUT") {
        if (pr.merged) return err(405, "Pull request has already been merged");
        if (pr.state !== "open") return err(405, "Pull request is closed");
        const baseRefName = `refs/heads/${pr.baseRef}`;
        const baseTip = repo.refs.get(baseRefName);
        if (!baseTip) return err(404, "Not Found");
        const headObj = repo.objects.get(pr.headSha);
        if (!headObj || headObj.type !== "commit") return err(422, "Validation Failed: head commit not found");
        let mergeSha: string;
        if (isAncestor(repo, baseTip, pr.headSha)) {
          // fast-forward
          mergeSha = pr.headSha;
          repo.refs.set(baseRefName, pr.headSha);
        } else {
          const base = mergeBase(repo, baseTip, pr.headSha);
          if (!base) return err(405, "Pull request cannot be merged: no merge base");
          const merged = mergeTrees(repo, baseTip, pr.headSha, base);
          if (!merged) return err(405, "Pull request cannot be merged: merge conflict");
          const ts = store.now();
          const unix = Math.floor(Date.parse(ts) / 1000);
          const who = `${owner} <${owner}@users.noreply.github.com> ${unix} +0000`;
          const data = serializeCommit({
            tree: merged.treeOid,
            parents: [baseTip, pr.headSha],
            author: who,
            committer: who,
            message: `Merge pull request #${pr.number} from ${owner}/${pr.headRef}`,
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
        repo.updatedAt = store.now();
        return json(200, { sha: mergeSha, merged: true, message: "Pull request successfully merged" });
      }
      return err(404, "Not Found");
    }
  }

  return err(404, "Not Found");
}
