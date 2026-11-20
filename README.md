# GitHub Core Clone — Lean-Robust Forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/Rifat7600/github-core-clone-01-3/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/Rifat7600/github-core-clone-01-3/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process. No git binary, no
database, no network, no model calls — just the standard library and an in-memory
store. It serves the four surfaces the suite drives:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (ls-refs,
  fetch, shallow) and receive-pack v0 (report-status, side-band-64k, delete-refs),
  with its own packfile reader/writer (including OFS/REF deltas) on `node:zlib`.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, issues,
  comments, labels, pull requests and merges, with pagination and GitHub-shaped
  JSON.
- **GraphQL v4** at `/api/graphql` — a small executor for the documents `gh` and
  `github-mcp-server` send, including introspection, batched operations and the
  `createPullRequest` / `mergePullRequest` mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28, with the
  six tools the suite drives (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same
  store as REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
serves until `$MAKEFUN_ENV_URL/done` answers `{"done": true}`, then exits 0.
Set `MAKEFUN_SHOP_TOKEN` to the bearer token it accepts and `MAKEFUN_TRIAL_SEED`
to seed its deterministic choices. All timestamps come from `MAKEFUN_TRIAL_NOW`,
so two runs of the same trial leave the same state.

## Layout

- `main.ts` — entrypoint: lifecycle (bind, register, poll done, exit).
- `app.ts` — HTTP server, routing, auth, request ids, JSON body handling.
- `store.ts` — the in-memory forge: repositories, issues, pull requests, labels
  and the git object store, keyed per bearer token.
- `gitobj.ts` — git objects: SHA-1 ids, commit/tree/blob/tag parsing and
  serialisation, delta application.
- `pack.ts` — packfile parsing and generation, reachability walks.
- `pkt.ts` — pkt-line framing and side-band-64k.
- `git-http.ts` — smart-HTTP endpoints: info/refs, upload-pack v2, receive-pack v0.
- `rest.ts` — the REST v3 routes.
- `graphql.ts` — the GraphQL lexer, parser and executor.
- `mcp.ts` — the MCP endpoint and its tools.

## Local verification

Against the kit's own conformance runner (`sdk/run.ts`, `--token
testtoken-abc123`), on a fresh server each run:

- **120/120 checks pass** — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  protocol 5/5, graphql 20/20, mcp 15/15 — confirmed by two independent runs
  that agree.
- **Score 935/1000** with `--perf` (feature 600, agent-native 200, perf 135);
  a second perf run scored 922 (perf 122). The forge is faster than the
  reference on all four timed workloads: push p50 939 ms (ref 1641 ms),
  clone p50 219 ms (ref 267 ms), read p50 1778 ms (ref 2760 ms), write
  p50 173 ms (ref 349 ms).
- Shallow fetch and deepen were verified against the real `git` CLI as well
  as the runner: `clone --depth 1`, `fetch --depth 2`, and repeated
  `fetch --deepen 1` all deliver the expected commits and update the
  client's shallow boundary.

