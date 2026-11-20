// store.ts — the forge's in-memory state.
//
// One process, one store. Data is scoped per bearer token: the token in
// MAKEFUN_SHOP_TOKEN owns the "adaiversen" namespace; any other token gets an
// empty namespace of its own, so a foreign token sees nothing (404) while a
// missing token is refused outright (401) by the router. All timestamps come
// from MAKEFUN_TRIAL_NOW plus a monotonic counter, never the wall clock, so
// two runs of the same trial leave identical state.

export interface GitObject {
  type: "commit" | "tree" | "blob" | "tag";
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  nextNumber: number; // shared issue/PR numbering, starts at 1
  nextLabelId: number;
  nextCommentId: number;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>; // keyed by lowercase name
  objects: Map<string, GitObject>; // oid hex -> object
  refs: Map<string, string>; // full refname -> oid hex
}

export interface Namespace {
  ownerLogin: string;
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextObjectId: number; // global sequential id for issues/PRs/comments
}

export class Store {
  namespaces = new Map<string, Namespace>();
  canonicalToken: string;
  baseTime: number; // ms epoch from MAKEFUN_TRIAL_NOW
  tick = 0;

  constructor() {
    this.canonicalToken = process.env.MAKEFUN_SHOP_TOKEN ?? "";
    const nowRaw = process.env.MAKEFUN_TRIAL_NOW ?? "";
    const parsed = nowRaw ? Date.parse(nowRaw) : NaN;
    this.baseTime = Number.isFinite(parsed) ? parsed : Date.parse("2026-11-14T06:30:00Z");
  }

  /** Monotonic ISO timestamp: base + one second per object created. */
  now(): string {
    const t = this.baseTime + this.tick * 1000;
    this.tick += 1;
    return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** The namespace for a token. The canonical token owns "adaiversen". */
  namespaceFor(token: string): Namespace {
    let ns = this.namespaces.get(token);
    if (!ns) {
      ns = {
        ownerLogin: token === this.canonicalToken ? "adaiversen" : "other-user",
        repos: new Map(),
        nextRepoId: 1,
        nextObjectId: 1,
      };
      this.namespaces.set(token, ns);
    }
    return ns;
  }

  createRepo(ns: Namespace, name: string, description: string, isPrivate: boolean): Repo {
    const ts = this.now();
    const repo: Repo = {
      id: ns.nextRepoId++,
      name,
      owner: ns.ownerLogin,
      description,
      isPrivate,
      defaultBranch: "main",
      createdAt: ts,
      updatedAt: ts,
      pushedAt: ts,
      nextNumber: 1,
      nextLabelId: 1,
      nextCommentId: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      objects: new Map(),
      refs: new Map(),
    };
    ns.repos.set(name, repo);
    return repo;
  }

  /** Node id: base64url of "Type:..." so node(id:) can decode it back. */
  static nodeId(kind: string, ...parts: (string | number)[]): string {
    return Buffer.from([kind, ...parts].join(":")).toString("base64url");
  }

  static decodeNodeId(id: string): { kind: string; parts: string[] } | null {
    try {
      const raw = Buffer.from(id, "base64url").toString("utf8");
      const [kind, ...parts] = raw.split(":");
      if (!kind || parts.length === 0) return null;
      return { kind, parts };
    } catch {
      return null;
    }
  }
}
