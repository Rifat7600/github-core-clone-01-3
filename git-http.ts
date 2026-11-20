// git-http.ts — git smart HTTP: info/refs, upload-pack (protocol v2 and
// v0) and receive-pack (v0). The wire formats follow git's documentation:
// v0 advertisements open with "# service=..." and list refs with the
// capability list after a NUL on the first line; v2 opens with "version 2"
// and lists capabilities one per line. Packfiles come from pack.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import { FLUSH, pktLine, parsePktLines, sideband, sidebandText } from "./pkt.ts";
import { buildPack, collectForFetch, isAncestor, parsePack, shallowBoundaryDepth } from "./pack.ts";
import { isZeroOid, parseCommit, parseTag, parseTree, ZERO_OID } from "./gitobj.ts";
import type { Repo } from "./store.ts";

const AGENT = "github-core-clone-01-3";

function headRef(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(FLUSH);
  const head = headRef(repo);
  const lines: string[] = [];
  if (head) lines.push(`${head} HEAD\0${caps}\n`);
  else lines.push(`${ZERO_OID} HEAD\0${caps}\n`);
  for (const [ref, oid] of sortedRefs(repo)) lines.push(`${oid} ${ref}\n`);
  for (const l of lines) parts.push(pktLine(l));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine("version 2\n"),
    pktLine("ls-refs=unborn\n"),
    pktLine("fetch=shallow wait-for-done filter\n"),
    pktLine("server-option\n"),
    pktLine("object-format=sha1\n"),
    pktLine(`agent=${AGENT}\n`),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | null,
  service: string,
  isV2: boolean,
): void {
  if (!repo) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
    return;
  }
  if (service === "git-upload-pack") {
    res.writeHead(200, {
      "Content-Type": "application/x-git-upload-pack-advertisement",
      "Cache-Control": "no-cache",
    });
    res.end(isV2 ? v2Advertisement() : v0Advertisement(repo, service, `side-band-64k side-band thin-pack ofs-delta agent=${AGENT}`));
  } else if (service === "git-receive-pack") {
    res.writeHead(200, {
      "Content-Type": "application/x-git-receive-pack-advertisement",
      "Cache-Control": "no-cache",
    });
    res.end(v0Advertisement(repo, service, `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`));
  } else {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "unknown service" }));
  }
}

// ------------------------------------------------------------ upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  done: boolean;
  deepen: number;
  deepenRelative: boolean;
  shallowLines: string[];
  filter: string;
  thinPack: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const a: FetchArgs = { wants: [], haves: [], done: false, deepen: 0, deepenRelative: false, shallowLines: [], filter: "", thinPack: false };
  for (const line of lines) {
    if (line.startsWith("want ")) a.wants.push(line.slice(5).trim());
    else if (line.startsWith("have ")) a.haves.push(line.slice(5).trim());
    else if (line === "done") a.done = true;
    else if (line.startsWith("deepen ")) a.deepen = parseInt(line.slice(7), 10) || 0;
    else if (line === "deepen-relative") a.deepenRelative = true;
    else if (line.startsWith("shallow ")) a.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith("filter ")) a.filter = line.slice(7).trim();
    else if (line === "thin-pack") a.thinPack = true;
  }
  return a;
}

export function handleUploadPack(
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | null,
  body: Buffer,
  isV2: boolean,
): void {
  if (!repo) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result" });
  const lines = parsePktLines(body)
    .filter((p) => p.kind === "line")
    .map((p) => p.data.toString("utf8").replace(/\n$/, ""));
  if (isV2) {
    const command = lines.find((l) => l.startsWith("command="))?.slice(8) ?? "";
    // parsePktLines drops the delim pkt-line, so the argument lines are
    // everything after the command/agent/object-format header lines.
    const realArgs = lines.filter(
      (l) => !l.startsWith("command=") && !l.startsWith("agent=") && !l.startsWith("object-format="),
    );
    if (command === "ls-refs") {
      res.end(lsRefsResponse(repo, realArgs));
      return;
    }
    if (command === "fetch") {
      res.end(fetchResponse(repo, parseFetchArgs(realArgs)));
      return;
    }
    res.end(pktLine("ERR unknown command\n"));
    return;
  }
  // v0: want/have/done lines
  const fetch = parseFetchArgs(lines);
  const parts: Buffer[] = [];
  if (fetch.haves.length === 0) {
    parts.push(pktLine("NAK\n"));
  } else {
    const common = fetch.haves.filter((h) => fetch.wants.some((w) => isAncestor(repo, h, w) || h === w));
    if (common.length > 0) parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
    else parts.push(pktLine("NAK\n"));
  }
  const { objects } = collectForFetch(repo, fetch.wants, new Set(fetch.haves), 0);
  parts.push(sideband(buildPack(objects)));
  parts.push(FLUSH);
  res.end(Buffer.concat(parts));
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes("peel");
  const unborn = args.includes("unborn");
  const symrefs = args.includes("symrefs");
  const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice(11));
  const parts: Buffer[] = [];
  const head = headRef(repo);
  const include = (ref: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  if (include("HEAD")) {
    if (head) {
      let line = `${head} HEAD`;
      if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      parts.push(pktLine(line + "\n"));
    } else if (unborn) {
      // Protocol v2 advertises an unborn ref with the literal word
      // "unborn" in place of the object id — not the zero oid. The zero
      // oid makes the client treat HEAD as a real ref pointing at a
      // branch that does not exist yet, and the clone comes out broken.
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!include(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === "tag") {
        const tag = parseTag(obj.data);
        line += ` peeled:${tag.object}`;
      }
    }
    parts.push(pktLine(line + "\n"));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  // A zero-oid want can only come from an unborn HEAD; it names no object.
  args.wants = args.wants.filter((w) => !isZeroOid(w));
  for (const w of args.wants) {
    if (!repo.objects.has(w)) {
      return Buffer.concat([pktLine(`ERR ${w} not found\n`), FLUSH]);
    }
  }
  const parts: Buffer[] = [];
  if (!args.done) {
    // The client has more haves to send; acknowledge and wait for the
    // next request round. (A client that sent "done" skips this section.)
    // The section is named "acknowledgments", with an s.
    parts.push(pktLine("acknowledgments\n"));
    const common = args.haves.filter((h) => args.wants.some((w) => isAncestor(repo, h, w) || h === w));
    if (common.length > 0) parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
    else parts.push(pktLine("NAK\n"));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  // Resolve the effective deepen. With `deepen-relative` the deepen is
  // relative to the client's current shallow boundary: add the boundary's
  // depth (measured from the wants) to the relative deepen.
  let effectiveDeepen = args.deepen;
  if (args.deepen > 0 && args.deepenRelative && args.shallowLines.length > 0) {
    const boundaryDepth = shallowBoundaryDepth(repo, args.wants, args.shallowLines);
    if (boundaryDepth > 0) effectiveDeepen = args.deepen + boundaryDepth;
  }
  const { objects, shallow, unshallow } = collectForFetch(
    repo,
    args.wants,
    new Set(args.haves),
    effectiveDeepen,
    args.shallowLines,
  );
  if (args.filter === "blob:none") {
    for (const [oid, o] of [...objects]) if (o.type === "blob") objects.delete(oid);
  } else if (args.filter === "tree:0") {
    for (const [oid, o] of [...objects]) if (o.type === "blob" || o.type === "tree") objects.delete(oid);
  }
  if (effectiveDeepen > 0 && (shallow.length > 0 || unshallow.length > 0)) {
    // The section is named "shallow-info", not "shallow". Shallow lines
    // come first, then unshallow lines for boundaries that are now inside
    // the fetched depth.
    parts.push(pktLine("shallow-info\n"));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine("packfile\n"));
  parts.push(sideband(buildPack(objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ----------------------------------------------------------- receive-pack

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | null,
  body: Buffer,
): void {
  if (!repo) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result" });
  // Split the body: pkt-lines of ref updates, a flush, then the raw pack.
  const updates: RefUpdate[] = [];
  let pos = 0;
  let packStart = -1;
  while (pos + 4 <= body.length) {
    const head = body.subarray(pos, pos + 4).toString("ascii");
    if (head === "0000") {
      packStart = pos + 4;
      break;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > body.length) break;
    let line = body.subarray(pos + 4, pos + len).toString("utf8");
    pos += len;
    const nul = line.indexOf("\0");
    if (nul >= 0) line = line.slice(0, nul); // capabilities on the first line
    const m = line.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (m) updates.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (packStart < 0) {
    // No pack at all (a pure ref-delete push has an empty pack).
    for (const u of updates) results.push(applyUpdate(repo, u));
    res.end(reportStatus(null, results));
    return;
  }
  const packBuf = body.subarray(packStart);
  let parsed: ReturnType<typeof parsePack> | null = null;
  let unpackError = "";
  // A pure ref-delete push carries no packfile at all (zero bytes after
  // the flush); that is not an error.
  if (packBuf.length > 0) {
    try {
      parsed = parsePack(packBuf, repo.objects);
    } catch (e) {
      unpackError = e instanceof Error ? e.message : "unpack failed";
    }
  }
  if (parsed) {
    for (const [oid, obj] of parsed.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  for (const u of updates) {
    if (unpackError) {
      results.push({ ref: u.ref, ok: false, reason: "unpack failed" });
      continue;
    }
    results.push(applyUpdate(repo, u));
  }
  res.end(reportStatus(unpackError || null, results));
}

function applyUpdate(repo: Repo, u: RefUpdate): { ref: string; ok: boolean; reason: string } {
  const fail = (reason: string) => ({ ref: u.ref, ok: false, reason });
  if (!u.ref.startsWith("refs/")) return fail("invalid ref name");
  const current = repo.refs.get(u.ref) ?? ZERO_OID;
  if (current !== u.oldOid) return fail("old value does not match");
  if (isZeroOid(u.newOid)) {
    // delete
    if (isZeroOid(current)) return fail("ref does not exist");
    repo.refs.delete(u.ref);
    return { ref: u.ref, ok: true, reason: "" };
  }
  const obj = repo.objects.get(u.newOid);
  if (!obj) return fail("unable to resolve new value");
  if (obj.type !== "commit" && obj.type !== "tag") return fail("new value is not a commit");
  if (!isZeroOid(u.oldOid)) {
    // update: must fast-forward
    const newCommit = obj.type === "tag" ? parseTag(obj.data).object : u.newOid;
    if (!isAncestor(repo, u.oldOid, newCommit)) {
      return fail("non-fast-forward");
    }
  }
  repo.refs.set(u.ref, u.newOid);
  return { ref: u.ref, ok: true, reason: "" };
}

function reportStatus(
  unpackError: string | null,
  results: { ref: string; ok: boolean; reason: string }[],
): Buffer {
  const lines: string[] = [];
  if (unpackError) lines.push(`unpack ${unpackError}\n`);
  else lines.push("unpack ok\n");
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  // The report travels inside side-band band 1, and the client parses the
  // band-1 data as a stream of pkt-lines — so each status line must itself
  // be pkt-line framed inside the sideband payload, AND the inner stream
  // must end with its own flush. Without the inner flush the client's
  // inner reader hits end-of-data mid-report and reports "the remote end
  // hung up unexpectedly", even though the lines themselves arrived.
  const inner = Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
  return Buffer.concat([sideband(inner), FLUSH]);
}

// ------------------------------------------------------------ tree helpers

export function readTreeAt(
  repo: Repo,
  commitOid: string,
  path: string,
): { type: "blob" | "tree" | null; oid: string | null; entry: { mode: string; name: string; oid: string }[] | null } {
  const commitObj = repo.objects.get(commitOid);
  if (!commitObj || commitObj.type !== "commit") return { type: null, oid: null, entry: null };
  const commit = parseCommit(commitObj.data);
  let treeOid = commit.tree;
  if (!path) {
    return { type: "tree", oid: treeOid, entry: treeEntries(repo, treeOid) };
  }
  const parts = path.split("/").filter((p) => p.length > 0);
  for (const part of parts) {
    const entries = treeEntries(repo, treeOid);
    if (!entries) return { type: null, oid: null, entry: null };
    const hit = entries.find((e) => e.name === part);
    if (!hit) return { type: null, oid: null, entry: null };
    const obj = repo.objects.get(hit.oid);
    if (!obj) return { type: null, oid: null, entry: null };
    if (obj.type === "tree") {
      treeOid = hit.oid;
    } else {
      return { type: "blob", oid: hit.oid, entry: null };
    }
  }
  return { type: "tree", oid: treeOid, entry: treeEntries(repo, treeOid) };
}

function treeEntries(repo: Repo, treeOid: string): { mode: string; name: string; oid: string }[] | null {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== "tree") return null;
  return parseTree(obj.data);
}

export function commitAtTip(repo: Repo): string | null {
  return headRef(repo);
}
