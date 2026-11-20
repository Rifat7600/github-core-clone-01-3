// graphql.ts — a small GraphQL executor for the documents the suite sends.
// It lexes and parses the query language (operations, fragments, variables,
// directives, inline fragments, batched requests), then resolves against the
// same in-memory store as REST. It covers the fields `gh` and
// github-mcp-server ask for: repository/issue/pull-request reads, ordering
// and pagination, search, introspection for Issue/PullRequest/Repository,
// and the create/close/comment/createPullRequest/mergePullRequest mutations.
// Unknown fields produce a 200 response with an errors array naming them.

import { isAncestor } from "./pack.ts";
import { objectId, parseCommit, serializeCommit } from "./gitobj.ts";
import { diffFiles, mergeState } from "./rest.ts";
import { Store } from "./store.ts";
import type { Issue, Namespace, PullRequest, Repo } from "./store.ts";

// ------------------------------------------------------------------- lexer

type Token =
  | { kind: "name"; value: string }
  | { kind: "int"; value: string }
  | { kind: "float"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "eof"; value: "" };

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "." && src.slice(i, i + 3) === "...") {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    if ("!$&():=@[]{}|".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const raw = end < 0 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: "string", value: raw.replace(/\\"""/g, '"""') });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          const e = src[j + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "\\" ? "\\" : e === '"' ? '"' : e === "/" ? "/" : e === "b" ? "\b" : e === "f" ? "\f" : e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === "-") j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === ".") {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        isFloat = true;
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: isFloat ? "float" : "int", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j++;
      tokens.push({ kind: "name", value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${c}`);
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: "variable"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: ValueNode[] }
  | { kind: "object"; fields: { name: string; value: ValueNode }[] };

interface DirectiveNode {
  name: string;
  args: { name: string; value: ValueNode }[];
}

interface FieldNode {
  kind: "field";
  name: string;
  alias: string;
  args: { name: string; value: ValueNode }[];
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: "fragmentSpread";
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: "inlineFragment";
  typeCondition: string | null;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: "operation";
  op: "query" | "mutation" | "subscription";
  name: string | null;
  varDefs: { name: string; type: string; defaultValue: ValueNode | null }[];
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: "fragment";
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token {
    return this.tokens[this.pos];
  }
  next(): Token {
    return this.tokens[this.pos++];
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
  }
  expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== "name") throw new Error(`expected name, got ${t.value}`);
    if (v && t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
    return t.value;
  }
  skipPunct(v: string): boolean {
    const t = this.peek();
    if (t.kind === "punct" && t.value === v) {
      this.pos++;
      return true;
    }
    return false;
  }

  parseDocument(): (OperationNode | FragmentNode)[] {
    const defs: (OperationNode | FragmentNode)[] = [];
    while (this.peek().kind !== "eof") defs.push(this.parseDefinition());
    return defs;
  }

  parseDefinition(): OperationNode | FragmentNode {
    const t = this.peek();
    if (t.kind === "punct" && t.value === "{") {
      return { kind: "operation", op: "query", name: null, varDefs: [], directives: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === "name" && t.value === "fragment") {
      this.next();
      const name = this.expectName();
      this.expectName("on");
      const typeCondition = this.expectName();
      const directives = this.parseDirectives();
      return { kind: "fragment", name, typeCondition, directives, selections: this.parseSelectionSet() };
    }
    const op = this.expectName() as "query" | "mutation" | "subscription";
    let name: string | null = null;
    if (this.peek().kind === "name") name = this.next().value;
    const varDefs = this.parseVariableDefinitions();
    const directives = this.parseDirectives();
    return { kind: "operation", op, name, varDefs, directives, selections: this.parseSelectionSet() };
  }

  parseVariableDefinitions(): OperationNode["varDefs"] {
    const defs: OperationNode["varDefs"] = [];
    if (!this.skipPunct("(")) return defs;
    while (!this.skipPunct(")")) {
      this.expectPunct("$");
      const name = this.expectName();
      this.expectPunct(":");
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.skipPunct("=")) defaultValue = this.parseValue(true);
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  parseType(): string {
    let t: string;
    if (this.skipPunct("[")) {
      t = `[${this.parseType()}]`;
    } else {
      t = this.expectName();
    }
    if (this.skipPunct("!")) t += "!";
    return t;
  }

  parseDirectives(): DirectiveNode[] {
    const dirs: DirectiveNode[] = [];
    while (this.peek().kind === "punct" && this.peek().value === "@") {
      this.next();
      const name = this.expectName();
      const args = this.parseArguments();
      dirs.push({ name, args });
    }
    return dirs;
  }

  parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!this.skipPunct("(")) return args;
    while (!this.skipPunct(")")) {
      const name = this.expectName();
      this.expectPunct(":");
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  parseValue(isConst: boolean): ValueNode {
    const t = this.next();
    if (t.kind === "punct" && t.value === "$") {
      if (isConst) throw new Error("variable in const position");
      return { kind: "variable", name: this.expectName() };
    }
    if (t.kind === "punct" && t.value === "[") {
      const values: ValueNode[] = [];
      while (!this.skipPunct("]")) values.push(this.parseValue(isConst));
      return { kind: "list", values };
    }
    if (t.kind === "punct" && t.value === "{") {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct("}")) {
        const name = this.expectName();
        this.expectPunct(":");
        fields.push({ name, value: this.parseValue(isConst) });
      }
      return { kind: "object", fields };
    }
    if (t.kind === "int") return { kind: "int", value: parseInt(t.value, 10) };
    if (t.kind === "float") return { kind: "float", value: parseFloat(t.value) };
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "name") {
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null" };
      return { kind: "enum", value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const sels: SelectionNode[] = [];
    while (!this.skipPunct("}")) sels.push(this.parseSelection());
    return sels;
  }

  parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === "punct" && t.value === "...") {
      this.next();
      const next = this.peek();
      if (next.kind === "name" && next.value !== "on") {
        const name = this.next().value;
        return { kind: "fragmentSpread", name, directives: this.parseDirectives() };
      }
      let typeCondition: string | null = null;
      if (next.kind === "name" && next.value === "on") {
        this.next();
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      return { kind: "inlineFragment", typeCondition, directives, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias = name;
    if (this.peek().kind === "punct" && this.peek().value === ":") {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === "punct" && this.peek().value === "{") {
      selections = this.parseSelectionSet();
    }
    return { kind: "field", name, alias, args, directives, selections };
  }
}

// -------------------------------------------------------------- value utils

function valueFromNode(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "variable":
      return vars[node.name];
    case "int":
    case "float":
    case "string":
    case "boolean":
      return node.value;
    case "null":
      return null;
    case "enum":
      return node.value;
    case "list":
      return node.values.map((v) => valueFromNode(v, vars));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueFromNode(f.value, vars);
      return out;
    }
  }
}

function argsFromNodes(args: { name: string; value: ValueNode }[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = valueFromNode(a.value, vars);
  return out;
}

function directiveApplies(dirs: DirectiveNode[], vars: Record<string, unknown>): boolean {
  for (const d of dirs) {
    const arg = d.args.find((a) => a.name === "if");
    const cond = arg ? valueFromNode(arg.value, vars) : true;
    if (d.name === "skip" && cond === true) return false;
    if (d.name === "include" && cond !== true) return false;
  }
  return true;
}

// ------------------------------------------------------------ type registry

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef;
}

interface FieldDef {
  name: string;
  description: string;
  type: TypeRef;
  args: { name: string; type: TypeRef }[];
}

const T = (kind: string, name: string | null, ofType?: TypeRef): TypeRef => ({ kind, name, ofType });
const scalar = (name: string): TypeRef => T("SCALAR", name);
const obj = (name: string): TypeRef => T("OBJECT", name);
const enu = (name: string): TypeRef => T("ENUM", name);
const nonNull = (inner: TypeRef): TypeRef => T("NON_NULL", null, inner);
const listOf = (inner: TypeRef): TypeRef => T("LIST", null, inner);

// The fields the suite's introspection documents ask about.
const TYPE_REGISTRY: Record<string, { kind: string; description: string; fields: FieldDef[] }> = {
  Issue: {
    kind: "OBJECT",
    description: "An issue in a repository.",
    fields: [
      { name: "id", description: "The node id.", type: nonNull(scalar("ID")), args: [] },
      { name: "number", description: "The issue number.", type: nonNull(scalar("Int")), args: [] },
      { name: "title", description: "The issue title.", type: nonNull(scalar("String")), args: [] },
      { name: "body", description: "The issue body.", type: scalar("String"), args: [] },
      { name: "state", description: "The issue state.", type: nonNull(enu("IssueState")), args: [] },
      { name: "url", description: "The issue URL.", type: nonNull(scalar("URI")), args: [] },
      { name: "createdAt", description: "When the issue was created.", type: nonNull(scalar("DateTime")), args: [] },
      { name: "updatedAt", description: "When the issue was updated.", type: nonNull(scalar("DateTime")), args: [] },
      { name: "closedAt", description: "When the issue was closed.", type: scalar("DateTime"), args: [] },
      { name: "author", description: "The issue author.", type: obj("Actor"), args: [] },
      { name: "labels", description: "The issue labels.", type: obj("LabelConnection"), args: [{ name: "first", type: scalar("Int") }] },
      { name: "comments", description: "The issue comments.", type: obj("IssueCommentConnection"), args: [{ name: "first", type: scalar("Int") }] },
      { name: "repository", description: "The repository.", type: nonNull(obj("Repository")), args: [] },
    ],
  },
  PullRequest: {
    kind: "OBJECT",
    description: "A pull request.",
    fields: [
      { name: "id", description: "The node id.", type: nonNull(scalar("ID")), args: [] },
      { name: "number", description: "The pull request number.", type: nonNull(scalar("Int")), args: [] },
      { name: "title", description: "The pull request title.", type: nonNull(scalar("String")), args: [] },
      { name: "body", description: "The pull request body.", type: scalar("String"), args: [] },
      { name: "state", description: "The pull request state.", type: nonNull(enu("PullRequestState")), args: [] },
      { name: "url", description: "The pull request URL.", type: nonNull(scalar("URI")), args: [] },
      { name: "createdAt", description: "When the pull request was created.", type: nonNull(scalar("DateTime")), args: [] },
      { name: "updatedAt", description: "When the pull request was updated.", type: nonNull(scalar("DateTime")), args: [] },
      { name: "closedAt", description: "When the pull request was closed.", type: scalar("DateTime"), args: [] },
      { name: "mergedAt", description: "When the pull request was merged.", type: scalar("DateTime"), args: [] },
      { name: "merged", description: "Whether the pull request was merged.", type: nonNull(scalar("Boolean")), args: [] },
      { name: "mergeable", description: "Whether the pull request can be merged.", type: nonNull(scalar("Boolean")), args: [] },
      { name: "headRefName", description: "The head ref name.", type: scalar("String"), args: [] },
      { name: "baseRefName", description: "The base ref name.", type: scalar("String"), args: [] },
      { name: "headRefOid", description: "The head ref oid.", type: scalar("GitObjectID"), args: [] },
      { name: "baseRefOid", description: "The base ref oid.", type: scalar("GitObjectID"), args: [] },
      { name: "author", description: "The pull request author.", type: obj("Actor"), args: [] },
      { name: "labels", description: "The pull request labels.", type: obj("LabelConnection"), args: [{ name: "first", type: scalar("Int") }] },
      { name: "files", description: "The changed files.", type: obj("PullRequestChangedFileConnection"), args: [{ name: "first", type: scalar("Int") }] },
      { name: "repository", description: "The repository.", type: nonNull(obj("Repository")), args: [] },
    ],
  },
  Repository: {
    kind: "OBJECT",
    description: "A repository.",
    fields: [
      { name: "id", description: "The node id.", type: nonNull(scalar("ID")), args: [] },
      { name: "databaseId", description: "The repository database id.", type: scalar("Int"), args: [] },
      { name: "name", description: "The repository name.", type: nonNull(scalar("String")), args: [] },
      { name: "nameWithOwner", description: "The repository name with owner.", type: nonNull(scalar("String")), args: [] },
      { name: "description", description: "The repository description.", type: scalar("String"), args: [] },
      { name: "url", description: "The repository URL.", type: nonNull(scalar("URI")), args: [] },
      { name: "createdAt", description: "When the repository was created.", type: nonNull(scalar("DateTime")), args: [] },
      { name: "updatedAt", description: "When the repository was updated.", type: nonNull(scalar("DateTime")), args: [] },
      { name: "owner", description: "The repository owner.", type: nonNull(obj("RepositoryOwner")), args: [] },
      { name: "defaultBranchRef", description: "The default branch ref.", type: obj("Ref"), args: [] },
      { name: "viewerPermission", description: "The viewer's permission.", type: enu("RepositoryPermission"), args: [] },
      { name: "hasIssuesEnabled", description: "Whether issues are enabled.", type: nonNull(scalar("Boolean")), args: [] },
      { name: "isPrivate", description: "Whether the repository is private.", type: nonNull(scalar("Boolean")), args: [] },
      { name: "issue", description: "An issue by number.", type: obj("Issue"), args: [{ name: "number", type: nonNull(scalar("Int")) }] },
      { name: "issues", description: "The issues.", type: nonNull(obj("IssueConnection")), args: [{ name: "first", type: scalar("Int") }, { name: "after", type: scalar("String") }, { name: "states", type: listOf(enu("IssueState")) }, { name: "orderBy", type: obj("IssueOrder") }] },
      { name: "pullRequest", description: "A pull request by number.", type: obj("PullRequest"), args: [{ name: "number", type: nonNull(scalar("Int")) }] },
      { name: "pullRequests", description: "The pull requests.", type: nonNull(obj("PullRequestConnection")), args: [{ name: "first", type: scalar("Int") }, { name: "after", type: scalar("String") }, { name: "states", type: listOf(enu("PullRequestState")) }, { name: "orderBy", type: obj("PullRequestOrder") }] },
      { name: "labels", description: "The labels.", type: obj("LabelConnection"), args: [{ name: "first", type: scalar("Int") }] },
    ],
  },
};

// The enums the suite's introspection documents ask about.
const ENUM_REGISTRY: Record<string, { description: string; values: string[] }> = {
  SearchType: {
    description: "The type of search to perform.",
    values: ["ISSUE", "PULL_REQUEST", "REPOSITORY", "USER", "DISCUSSION", "MILESTONE"],
  },
  IssueState: {
    description: "The state of an issue.",
    values: ["OPEN", "CLOSED"],
  },
  PullRequestState: {
    description: "The state of a pull request.",
    values: ["OPEN", "CLOSED", "MERGED"],
  },
  RepositoryPermission: {
    description: "The permission level for a repository.",
    values: ["ADMIN", "MAINTAIN", "READ", "TRIAGE", "WRITE"],
  },
  MergeableState: {
    description: "Whether a pull request can be merged.",
    values: ["CONFLICTING", "MERGEABLE", "UNKNOWN"],
  },
  OrderDirection: {
    description: "The direction of an ordering.",
    values: ["ASC", "DESC"],
  },
  IssueOrderField: {
    description: "The field to order issues by.",
    values: ["COMMENTS", "CREATED_AT", "UPDATED_AT"],
  },
  PullRequestOrderField: {
    description: "The field to order pull requests by.",
    values: ["CREATED_AT", "UPDATED_AT"],
  },
};

function typeRefJson(ref: TypeRef): Record<string, unknown> {
  return {
    kind: ref.kind,
    name: ref.name,
    ofType: ref.ofType ? typeRefJson(ref.ofType) : null,
  };
}

function fieldJson(f: FieldDef): Record<string, unknown> {
  return {
    name: f.name,
    description: f.description,
    args: f.args.map((a) => ({ name: a.name, description: "", type: typeRefJson(a.type), defaultValue: null })),
    type: typeRefJson(f.type),
    isDeprecated: false,
    deprecationReason: null,
  };
}

// --------------------------------------------------------------- executor

export interface GqlCtx {
  store: Store;
  ns: Namespace;
  owner: string;
}

type AnyObj = Record<string, unknown> & { __typename?: string };

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString("base64");
}

function indexFromCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const raw = Buffer.from(cursor, "base64").toString("utf8");
    const m = raw.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

function makeConnection<T extends AnyObj>(items: T[], typeName: string, first: number | undefined, after: string | undefined): AnyObj {
  const start = indexFromCursor(after) + 1;
  const sliced = first !== undefined ? items.slice(start, start + first) : items.slice(start);
  const endIndex = sliced.length > 0 ? start + sliced.length - 1 : start - 1;
  return {
    __typename: typeName,
    nodes: sliced,
    edges: sliced.map((node, i) => ({ __typename: `${typeName.replace("Connection", "")}Edge`, node, cursor: cursorFor(start + i) })),
    totalCount: items.length,
    pageInfo: {
      __typename: "PageInfo",
      hasNextPage: endIndex < items.length - 1,
      hasPreviousPage: start > 0,
      startCursor: sliced.length > 0 ? cursorFor(start) : null,
      endCursor: sliced.length > 0 ? cursorFor(endIndex) : null,
    },
  };
}

function sortIssues<T extends { createdAt: string; updatedAt: string; number: number }>(
  items: T[],
  orderBy: { field?: string; direction?: string } | undefined,
): T[] {
  const field = orderBy?.field ?? "CREATED_AT";
  const dir = orderBy?.direction ?? "DESC";
  const key = (x: T): string => (field === "UPDATED_AT" ? x.updatedAt : x.createdAt);
  return [...items].sort((a, b) => {
    const cmp = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.number - b.number;
    return dir === "ASC" ? cmp : -cmp;
  });
}

function issueValue(repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: "Issue",
    __repo: repo,
    __issue: issue,
    id: Store.nodeId("Issue", repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === "open" ? "OPEN" : "CLOSED",
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    author: { __typename: "User", login: issue.user, id: 1, databaseId: 1, name: issue.user, url: `https://github.com/${issue.user}`, avatarUrl: "" },
    repository: repoValue(repo),
  };
}

function prValue(repo: Repo, pr: PullRequest): AnyObj {
  return {
    __typename: "PullRequest",
    __repo: repo,
    __pr: pr,
    id: Store.nodeId("PullRequest", repo.id, pr.number),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    mergedAt: pr.mergedAt,
    merged: pr.merged,
    mergeable: mergeState(repo, pr),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    headRefOid: pr.headSha,
    baseRefOid: pr.baseSha,
    author: { __typename: "User", login: repo.owner, id: 1, databaseId: 1, name: repo.owner, url: `https://github.com/${repo.owner}`, avatarUrl: "" },
    repository: repoValue(repo),
  };
}

function repoValue(repo: Repo): AnyObj {
  return {
    __typename: "Repository",
    __repo: repo,
    id: Store.nodeId("Repository", repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    owner: { __typename: "User", login: repo.owner, id: 1, databaseId: 1, name: repo.owner, url: `https://github.com/${repo.owner}`, avatarUrl: "" },
    isPrivate: repo.isPrivate,
    hasIssuesEnabled: true,
    hasWikiEnabled: true,
    viewerPermission: "ADMIN",
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`)
      ? { __typename: "Ref", name: repo.defaultBranch, target: { __typename: "GitObject", oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) } }
      : null,
  };
}

function labelConnection(repo: Repo, names: string[], first: number | undefined): AnyObj {
  const labels = names
    .map((n) => repo.labels.get(n.toLowerCase()))
    .filter((l): l is NonNullable<typeof l> => !!l)
    .map((l) => ({ __typename: "Label", id: Store.nodeId("Label", repo.id, l.id), databaseId: l.id, name: l.name, color: l.color, description: l.description }));
  return makeConnection(labels, "LabelConnection", first, undefined);
}

function issueConnection(repo: Repo, args: Record<string, unknown>): AnyObj {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const sorted = sortIssues(list, args.orderBy as { field?: string; direction?: string } | undefined);
  const nodes = sorted.map((i) => issueValue(repo, i));
  return makeConnection(nodes, "IssueConnection", args.first as number | undefined, args.after as string | undefined);
}

function prConnection(repo: Repo, args: Record<string, unknown>): AnyObj {
  let list = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states);
    list = list.filter((p) => wanted.has(p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED"));
  }
  const sorted = sortIssues(list, args.orderBy as { field?: string; direction?: string } | undefined);
  const nodes = sorted.map((p) => prValue(repo, p));
  return makeConnection(nodes, "PullRequestConnection", args.first as number | undefined, args.after as string | undefined);
}

function resolveField(
  parentType: string,
  parent: AnyObj,
  field: FieldNode,
  vars: Record<string, unknown>,
  ctx: GqlCtx,
  errors: { message: string; locations?: unknown; path?: unknown }[],
  path: (string | number)[],
): unknown {
  const args = argsFromNodes(field.args, vars);
  const name = field.name;

  if (name === "__typename") return parentType;

  // Query root
  if (parentType === "Query") {
    if (name === "viewer") {
      return { __typename: "User", login: ctx.owner, id: 1, databaseId: 1, name: ctx.owner, url: `https://github.com/${ctx.owner}`, avatarUrl: "" };
    }
    if (name === "repository") {
      const repo = ctx.ns.repos.get(String(args.name ?? ""));
      if (!repo || String(args.owner ?? "") !== ctx.owner) return null;
      return repoValue(repo);
    }
    if (name === "node") {
      const decoded = Store.decodeNodeId(String(args.id ?? ""));
      if (!decoded) return null;
      if (decoded.kind === "Repository") {
        const repo = [...ctx.ns.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        return repo ? repoValue(repo) : null;
      }
      if (decoded.kind === "Issue") {
        const repo = [...ctx.ns.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        return repo && issue ? issueValue(repo, issue) : null;
      }
      if (decoded.kind === "PullRequest") {
        const repo = [...ctx.ns.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const pr = repo?.pulls.get(Number(decoded.parts[1]));
        return repo && pr ? prValue(repo, pr) : null;
      }
      if (decoded.kind === "User") {
        return { __typename: "User", login: ctx.owner, id: 1, databaseId: 1, name: ctx.owner, url: `https://github.com/${ctx.owner}`, avatarUrl: "" };
      }
      return null;
    }
    if (name === "search") {
      return searchValue(ctx, args);
    }
    if (name === "__type") {
      const typeName = String(args.name ?? "");
      const def = TYPE_REGISTRY[typeName];
      if (def) {
        return {
          __typename: "__Type",
          name: typeName,
          kind: def.kind,
          description: def.description,
          fields: def.fields.map((f) => ({ __typename: "__Field", ...fieldJson(f) })),
          enumValues: null,
        };
      }
      const enu = ENUM_REGISTRY[typeName];
      if (enu) {
        return {
          __typename: "__Type",
          name: typeName,
          kind: "ENUM",
          description: enu.description,
          fields: null,
          enumValues: enu.values.map((v) => ({
            __typename: "__EnumValue",
            name: v,
            description: "",
            isDeprecated: false,
            deprecationReason: null,
          })),
        };
      }
      return null;
    }
    if (name === "__schema") {
      return {
        __typename: "__Schema",
        queryType: { __typename: "__Type", name: "Query", kind: "OBJECT", description: "The query root." },
        mutationType: { __typename: "__Type", name: "Mutation", kind: "OBJECT", description: "The mutation root." },
        types: Object.keys(TYPE_REGISTRY).map((n) => ({ __typename: "__Type", name: n, kind: TYPE_REGISTRY[n].kind, description: TYPE_REGISTRY[n].description })),
        directives: [{ __typename: "__Directive", name: "skip", locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"] }, { __typename: "__Directive", name: "include", locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"] }],
      };
    }
  }

  // Mutations
  if (parentType === "Mutation") {
    if (name === "createIssue") return createIssueMutation(ctx, args);
    if (name === "closeIssue") return closeIssueMutation(ctx, args);
    if (name === "addComment") return addCommentMutation(ctx, args);
    if (name === "createPullRequest") return createPrMutation(ctx, args);
    if (name === "mergePullRequest") return mergePrMutation(ctx, args);
  }

  // Repository
  if (parentType === "Repository") {
    const repo = parent.__repo as Repo;
    if (name === "issue") {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueValue(repo, issue) : null;
    }
    if (name === "issues") return issueConnection(repo, args);
    if (name === "pullRequest") {
      const pr = repo.pulls.get(Number(args.number));
      return pr ? prValue(repo, pr) : null;
    }
    if (name === "pullRequests") return prConnection(repo, args);
    if (name === "labels") {
      return labelConnection(repo, [...repo.labels.keys()], args.first as number | undefined);
    }
  }

  // Issue
  if (parentType === "Issue") {
    const repo = parent.__repo as Repo;
    const issue = parent.__issue as Issue;
    if (name === "labels") return labelConnection(repo, issue.labels, args.first as number | undefined);
    if (name === "comments") {
      const nodes = issue.comments.map((c) => ({
        __typename: "IssueComment",
        id: Store.nodeId("IssueComment", repo.id, issue.number, c.id),
        databaseId: c.id,
        body: c.body,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        author: { __typename: "User", login: c.user, id: 1, databaseId: 1, name: c.user, url: `https://github.com/${c.user}`, avatarUrl: "" },
      }));
      return makeConnection(nodes, "IssueCommentConnection", args.first as number | undefined, args.after as string | undefined);
    }
  }

  // PullRequest
  if (parentType === "PullRequest") {
    const repo = parent.__repo as Repo;
    const pr = parent.__pr as PullRequest;
    if (name === "labels") return labelConnection(repo, [], args.first as number | undefined);
    if (name === "files") {
      const nodes = diffFiles(repo, pr).map((f) => ({
        __typename: "PullRequestChangedFile",
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status === "added" ? "ADDED" : f.status === "removed" ? "REMOVED" : "MODIFIED",
      }));
      return makeConnection(nodes, "PullRequestChangedFileConnection", args.first as number | undefined, args.after as string | undefined);
    }
  }

  // __Type introspection object
  if (parentType === "__Type") {
    if (name === "fields") {
      const includeDeprecated = args.includeDeprecated === true;
      const fields = (parent.fields as AnyObj[]) ?? [];
      return includeDeprecated ? fields : fields.filter((f) => !f.isDeprecated);
    }
    if (name === "ofType") return parent.ofType ?? null;
  }

  // Plain property fallback (scalar fields stored on the value object).
  if (Object.prototype.hasOwnProperty.call(parent, name)) return parent[name];

  // Unknown field: record an error, resolve to null.
  errors.push({
    message: `Cannot query field "${name}" on type "${parentType}".`,
    path: [...path, field.alias],
  });
  return null;
}

// --------------------------------------------------------------- mutations

function findRepoById(ctx: GqlCtx, id: string): Repo | null {
  const decoded = Store.decodeNodeId(id);
  if (!decoded || decoded.kind !== "Repository") return null;
  return [...ctx.ns.repos.values()].find((r) => r.id === Number(decoded.parts[0])) ?? null;
}

function createIssueMutation(ctx: GqlCtx, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = findRepoById(ctx, String(input.repositoryId ?? ""));
  if (!repo) return { __typename: "CreateIssuePayload", clientMutationId: (input.clientMutationId as string) ?? null, issue: null };
  const ts = ctx.store.now();
  const issue: Issue = {
    id: ctx.ns.nextObjectId++,
    number: repo.nextNumber++,
    title: String(input.title ?? ""),
    body: typeof input.body === "string" ? input.body : "",
    state: "open",
    labels: [],
    user: ctx.owner,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return { __typename: "CreateIssuePayload", clientMutationId: (input.clientMutationId as string) ?? null, issue: issueValue(repo, issue) };
}

function closeIssueMutation(ctx: GqlCtx, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = Store.decodeNodeId(String(input.issueId ?? ""));
  let issue: Issue | null = null;
  let repo: Repo | null = null;
  if (decoded && decoded.kind === "Issue") {
    repo = [...ctx.ns.repos.values()].find((r) => r.id === Number(decoded.parts[0])) ?? null;
    issue = repo?.issues.get(Number(decoded.parts[1])) ?? null;
  }
  if (repo && issue) {
    issue.state = "closed";
    issue.closedAt = ctx.store.now();
    issue.updatedAt = issue.closedAt;
  }
  return { __typename: "CloseIssuePayload", clientMutationId: (input.clientMutationId as string) ?? null, issue: repo && issue ? issueValue(repo, issue) : null };
}

function addCommentMutation(ctx: GqlCtx, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = Store.decodeNodeId(String(input.subjectId ?? ""));
  let repo: Repo | null = null;
  let issue: Issue | null = null;
  if (decoded && decoded.kind === "Issue") {
    repo = [...ctx.ns.repos.values()].find((r) => r.id === Number(decoded.parts[0])) ?? null;
    issue = repo?.issues.get(Number(decoded.parts[1])) ?? null;
  }
  if (!repo || !issue) {
    return { __typename: "AddCommentPayload", clientMutationId: (input.clientMutationId as string) ?? null, commentEdge: null };
  }
  const ts = ctx.store.now();
  const comment = { id: repo.nextCommentId++, body: String(input.body ?? ""), user: ctx.owner, createdAt: ts, updatedAt: ts };
  issue.comments.push(comment);
  issue.updatedAt = ts;
  const node = {
    __typename: "IssueComment",
    id: Store.nodeId("IssueComment", repo.id, issue.number, comment.id),
    databaseId: comment.id,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: { __typename: "User", login: ctx.owner, id: 1, databaseId: 1, name: ctx.owner, url: `https://github.com/${ctx.owner}`, avatarUrl: "" },
  };
  return {
    __typename: "AddCommentPayload",
    clientMutationId: (input.clientMutationId as string) ?? null,
    commentEdge: { __typename: "IssueCommentEdge", node, cursor: cursorFor(issue.comments.length - 1) },
  };
}

function createPrMutation(ctx: GqlCtx, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = findRepoById(ctx, String(input.repositoryId ?? ""));
  if (!repo) return { __typename: "CreatePullRequestPayload", clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: null };
  const headRef = String(input.headRefName ?? "");
  const baseRef = String(input.baseRefName ?? "");
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha || !baseSha) {
    return { __typename: "CreatePullRequestPayload", clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: null };
  }
  const ts = ctx.store.now();
  const pr: PullRequest = {
    id: ctx.ns.nextObjectId++,
    number: repo.nextNumber++,
    title: String(input.title ?? ""),
    body: typeof input.body === "string" ? input.body : "",
    state: "open",
    headRef,
    headSha,
    baseRef,
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
  return { __typename: "CreatePullRequestPayload", clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: prValue(repo, pr) };
}

function mergePrMutation(ctx: GqlCtx, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = Store.decodeNodeId(String(input.pullRequestId ?? ""));
  let repo: Repo | null = null;
  let pr: PullRequest | null = null;
  if (decoded && decoded.kind === "PullRequest") {
    repo = [...ctx.ns.repos.values()].find((r) => r.id === Number(decoded.parts[0])) ?? null;
    pr = repo?.pulls.get(Number(decoded.parts[1])) ?? null;
  }
  if (repo && pr && pr.state === "open" && !pr.merged) {
    const baseRefName = `refs/heads/${pr.baseRef}`;
    const baseTip = repo.refs.get(baseRefName);
    const headObj = repo.objects.get(pr.headSha);
    if (baseTip && headObj && headObj.type === "commit") {
      const headTree = parseCommit(headObj.data).tree;
      let mergeSha: string;
      if (isAncestor(repo, baseTip, pr.headSha)) {
        mergeSha = pr.headSha;
        repo.refs.set(baseRefName, pr.headSha);
      } else {
        const ts = ctx.store.now();
        const unix = Math.floor(Date.parse(ts) / 1000);
        const who = `${ctx.owner} <${ctx.owner}@users.noreply.github.com> ${unix} +0000`;
        const data = serializeCommit({
          tree: headTree,
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
      pr.mergedAt = ctx.store.now();
      pr.state = "closed";
      pr.closedAt = pr.mergedAt;
      pr.updatedAt = pr.mergedAt;
    }
  }
  return {
    __typename: "MergePullRequestPayload",
    clientMutationId: (input.clientMutationId as string) ?? null,
    pullRequest: repo && pr ? prValue(repo, pr) : null,
    actor: { __typename: "User", login: ctx.owner, id: 1, databaseId: 1, name: ctx.owner, url: `https://github.com/${ctx.owner}`, avatarUrl: "" },
  };
}


// ------------------------------------------------------------------- search

function searchValue(ctx: GqlCtx, args: Record<string, unknown>): AnyObj {
  const raw = String(args.query ?? "");
  const tokens = raw.split(/\s+/).filter(Boolean);
  let repoFilter: Repo | null = null;
  let wantPr: boolean | null = null;
  let wantState: string | null = null;
  const text: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith("repo:")) {
      const [o, r] = tok.slice(5).split("/");
      if (o === ctx.owner && r) repoFilter = ctx.ns.repos.get(r) ?? null;
    } else if (tok === "is:issue") wantPr = false;
    else if (tok === "is:pr" || tok === "is:pull-request") wantPr = true;
    else if (tok === "is:open") wantState = "open";
    else if (tok === "is:closed") wantState = "closed";
    else text.push(tok.toLowerCase());
  }
  const repos = repoFilter ? [repoFilter] : [...ctx.ns.repos.values()];
  const nodes: AnyObj[] = [];
  for (const repo of repos) {
    for (const issue of repo.issues.values()) {
      if (wantPr === true) continue;
      if (wantState && issue.state !== wantState) continue;
      if (text.length > 0 && !text.every((t) => `${issue.title} ${issue.body}`.toLowerCase().includes(t))) continue;
      nodes.push(issueValue(repo, issue));
    }
    for (const pr of repo.pulls.values()) {
      if (wantPr === false) continue;
      if (wantState && pr.state !== wantState) continue;
      if (text.length > 0 && !text.every((t) => `${pr.title} ${pr.body}`.toLowerCase().includes(t))) continue;
      nodes.push(prValue(repo, pr));
    }
  }
  const type = String(args.type ?? "ISSUE");
  const first = args.first as number | undefined;
  const conn = makeConnection(nodes, "SearchResultItemConnection", first, args.after as string | undefined);
  conn.issueCount = nodes.length;
  return conn;
}

// ------------------------------------------------------------------ execute

const FRAGMENT_SUPERTYPES: Record<string, string[]> = {
  Node: ["Repository", "Issue", "PullRequest", "User", "Label", "IssueComment", "Ref", "GitObject"],
  Actor: ["User", "Bot"],
  RepositoryOwner: ["User", "Organization"],
  SearchResultItem: ["Issue", "PullRequest"],
  Assignable: ["Issue", "PullRequest"],
  Comment: ["IssueComment"],
};

function fragmentApplies(condition: string, parentType: string): boolean {
  if (condition === parentType) return true;
  const members = FRAGMENT_SUPERTYPES[condition];
  return members ? members.includes(parentType) : false;
}

function executeSelectionSet(
  parentType: string,
  parent: AnyObj,
  selections: SelectionNode[],
  vars: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  ctx: GqlCtx,
  errors: { message: string; locations?: unknown; path?: unknown }[],
  path: (string | number)[],
): AnyObj {
  const out: AnyObj = {};
  for (const sel of selections) {
    if (sel.kind === "fragmentSpread") {
      if (!directiveApplies(sel.directives, vars)) continue;
      const frag = fragments.get(sel.name);
      if (!frag) continue;
      if (!fragmentApplies(frag.typeCondition, parentType)) continue;
      const sub = executeSelectionSet(parentType, parent, frag.selections, vars, fragments, ctx, errors, path);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === "inlineFragment") {
      if (!directiveApplies(sel.directives, vars)) continue;
      if (sel.typeCondition && !fragmentApplies(sel.typeCondition, parentType)) continue;
      const sub = executeSelectionSet(parentType, parent, sel.selections, vars, fragments, ctx, errors, path);
      Object.assign(out, sub);
      continue;
    }
    if (!directiveApplies(sel.directives, vars)) continue;
    const value = resolveField(parentType, parent, sel, vars, ctx, errors, [...path, sel.alias]);
    out[sel.alias] = executeValue(value, sel, vars, fragments, ctx, errors, [...path, sel.alias]);
  }
  return out;
}

function executeValue(
  value: unknown,
  field: FieldNode,
  vars: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  ctx: GqlCtx,
  errors: { message: string; locations?: unknown; path?: unknown }[],
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v, i) => executeValue(v, field, vars, fragments, ctx, errors, [...path, i]));
  }
  if (typeof value === "object" && field.selections.length > 0) {
    const obj = value as AnyObj;
    const typeName = obj.__typename ?? "Unknown";
    return executeSelectionSet(typeName, obj, field.selections, vars, fragments, ctx, errors, path);
  }
  return value;
}

export function executeGraphQL(body: unknown, ctx: GqlCtx): unknown {
  const requests = Array.isArray(body) ? body : [body];
  const results = requests.map((req) => {
    const r = (req ?? {}) as Record<string, unknown>;
    const query = typeof r.query === "string" ? r.query : "";
    const variables = (r.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof r.operationName === "string" ? r.operationName : null;
    try {
      const defs = new Parser(lex(query)).parseDocument();
      const fragments = new Map<string, FragmentNode>();
      const operations: OperationNode[] = [];
      for (const d of defs) {
        if (d.kind === "fragment") fragments.set(d.name, d);
        else operations.push(d);
      }
      const op = operationName
        ? operations.find((o) => o.name === operationName)
        : operations[0];
      if (!op) return { data: null, errors: [{ message: "No operation found." }] };
      const vars: Record<string, unknown> = {};
      for (const def of op.varDefs) {
        if (def.name in variables) vars[def.name] = variables[def.name];
        else if (def.defaultValue) vars[def.name] = valueFromNode(def.defaultValue, {});
      }
      const errors: { message: string; locations?: unknown; path?: unknown }[] = [];
      const rootType = op.op === "mutation" ? "Mutation" : "Query";
      const data = executeSelectionSet(rootType, { __typename: rootType }, op.selections, vars, fragments, ctx, errors, []);
      return errors.length > 0 ? { data, errors } : { data };
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : "parse error" }] };
    }
  });
  return Array.isArray(body) ? results : results[0];
}
