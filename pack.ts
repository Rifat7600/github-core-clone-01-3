// pack.ts — packfile parsing and generation, plus reachability walks.
// A packfile is: "PACK" + u32 version (2) + u32 count, then per object a
// varint type/size header and zlib data (plain, OFS_DELTA or REF_DELTA),
// then the 20-byte SHA-1 trailer of everything before it. We write plain
// (non-delta) objects only; we read and apply both delta forms, because a
// pushing client may send either.

import { inflateSync, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { applyDelta, objectId, parseCommit, parseTag, parseTree, type ObjType } from "./gitobj.ts";
import type { GitObject, Repo } from "./store.ts";

const TYPE_NAMES: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface ParsedPack {
  objects: Map<string, GitObject>;
}

/**
 * Parse a whole packfile buffer into objects. Throws on any malformation.
 * `existing` holds objects the receiver already has: a pushing client sends
 * a thin pack, whose deltas may be based on an object that is not in the
 * pack but is already on the server.
 */
export function parsePack(buf: Buffer, existing?: Map<string, GitObject>): ParsedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("bad pack header");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error("unsupported pack version");
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  // offset -> oid, for resolving OFS_DELTA bases
  const byOffset = new Map<number, string>();
  // deferred deltas: [oid, baseOid|null, baseOffset|null, deltaData, type]
  const deferred: { baseOid: string | null; baseOff: number | null; delta: Buffer; objOff: number }[] = [];
  let pos = 12;
  for (let n = 0; n < count; n++) {
    const objOff = pos;
    let b = buf[pos++];
    const typeNum = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint
      let offByte = buf[pos++];
      let baseOff = offByte & 0x7f;
      while (offByte & 0x80) {
        offByte = buf[pos++];
        baseOff = ((baseOff + 1) << 7) | (offByte & 0x7f);
      }
      const baseObjOff = objOff - baseOff;
      const { data, next } = inflateFrom(buf, pos, size);
      pos = next;
      deferred.push({ baseOid: null, baseOff: baseObjOff, delta: data, objOff });
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid
      const baseOid = buf.subarray(pos, pos + 20).toString("hex");
      pos += 20;
      const { data, next } = inflateFrom(buf, pos, size);
      pos = next;
      deferred.push({ baseOid, baseOff: null, delta: data, objOff });
    } else {
      const type = TYPE_NAMES[typeNum];
      if (!type) throw new Error("bad object type in pack");
      const { data, next } = inflateFrom(buf, pos, size);
      pos = next;
      const oid = objectId(type, data);
      objects.set(oid, { type, data });
      byOffset.set(objOff, oid);
    }
  }
  // Resolve deltas. A delta's base may itself be a delta; resolve in passes.
  // A base that is not in the pack at all is looked up in `existing`
  // (the thin-pack case: the base already lives on the receiver).
  let guard = 0;
  while (deferred.length > 0) {
    if (++guard > count + 10) throw new Error("delta chain does not resolve");
    const d = deferred.shift()!;
    let baseOid = d.baseOid;
    if (baseOid === null && d.baseOff !== null) baseOid = byOffset.get(d.baseOff) ?? null;
    if (baseOid === null) {
      // base not yet resolved (it was itself a delta); retry later
      deferred.push(d);
      continue;
    }
    const base = objects.get(baseOid) ?? existing?.get(baseOid);
    if (!base) {
      // The base may be the result of another delta in this pack that has
      // not been resolved yet; retry later. A genuinely missing base is
      // caught by the guard below.
      deferred.push(d);
      continue;
    }
    const data = applyDelta(base.data, d.delta);
    const oid = objectId(base.type, data);
    objects.set(oid, { type: base.type, data });
    byOffset.set(d.objOff, oid);
  }
  return { objects };
}

function inflateFrom(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; next: number } {
  // inflateSync tolerates trailing bytes, so success is monotone in the
  // window end: any window reaching the stream end inflates, any shorter
  // window throws. Binary-search the smallest successful window. The
  // deflate output is at most ~0.03% larger than its input plus 5 bytes
  // per 64KiB stored block, so the bound below always covers the stream.
  const bound = Math.min(
    buf.length,
    pos + expectedSize + Math.ceil(expectedSize / 1000) * 5 + 64,
  );
  let lo = pos + 1;
  let hi = bound;
  let data: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(buf.subarray(pos, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === null) data = inflateSync(buf.subarray(pos, bound));
  if (data.length !== expectedSize) throw new Error("object size mismatch in pack");
  return { data, next: hi };
}

/** Build a packfile holding the given objects as plain (non-delta) entries. */
export function buildPack(objects: Map<string, GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  parts.push(header);
  for (const [, obj] of objects) {
    const typeCode = TYPE_CODES[obj.type];
    const size = obj.data.length;
    // varint header: first byte holds type in bits 4-6 and low 4 size bits
    const hdr: number[] = [];
    let s = size;
    hdr.push(((typeCode & 0x7) << 4) | (s & 0x0f));
    s >>= 4;
    while (s > 0) {
      hdr[hdr.length - 1] |= 0x80;
      hdr.push(s & 0x7f);
      s >>= 7;
    }
    parts.push(Buffer.from(hdr));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const trailer = createHash("sha1").update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------- reachability

/** Walk commit parents from `tip`, stopping at any oid in `stop`. */
export function walkCommits(repo: Repo, tip: string, stop: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid) || stop.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    out.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

/** Is `anc` an ancestor of (or equal to) `desc`? */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === anc) return true;
      stack.push(p);
    }
  }
  return false;
}

function collectTree(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== "tree") return;
  out.set(treeOid, obj);
  for (const e of parseTree(obj.data)) {
    const child = repo.objects.get(e.oid);
    if (!child) continue;
    if (child.type === "tree") collectTree(repo, e.oid, out);
    else out.set(e.oid, child);
  }
}

/**
 * Objects to send for `wants`, excluding anything the client already holds
 * (anything reachable from `haves` — commits, trees and blobs alike, so a
 * blob shared with a held commit is never re-sent). `depth` is the deepen
 * count: 0 means the full history, 1 the wanted commits only, 2 the wanted
 * commits and their parents, and so on. Returns the objects plus the
 * shallow boundary (the commits at exactly `depth`, which the client must
 * record as shallow) and the `unshallow` list: client shallow commits that
 * now sit inside the fetched depth and are no longer a boundary.
 *
 * When a deepen is in force the walk goes THROUGH held commits: in a
 * deepen fetch the wanted tip itself is a have, and its parents are what
 * the client is asking for. Without a deepen, held commits are a hard
 * boundary (the normal incremental-fetch rule).
 */
export function collectForFetch(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number,
  clientShallow: string[] = [],
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const held = reachableObjects(repo, [...haves], new Set(clientShallow));
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const clientShallowSet = new Set(clientShallow);
  const dist = new Map<string, number>();
  const queue: [string, number][] = wants.map((w) => [w, 1] as [string, number]);
  const commits = new Set<string>();
  while (queue.length > 0) {
    const [oid, d] = queue.shift()!;
    if (dist.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    dist.set(oid, d);
    const isHeld = held.has(oid);
    // A client shallow commit that now sits inside the fetched depth is
    // no longer a boundary: report it as unshallow.
    if (clientShallowSet.has(oid) && depth > 0 && d < depth) {
      unshallow.push(oid);
    }
    if (depth > 0 && d >= depth) {
      // At the depth boundary. Only a commit being sent becomes a new
      // shallow boundary; one the client already holds is not.
      if (!isHeld) {
        shallow.push(oid);
        commits.add(oid);
      }
      // Do not traverse past the boundary.
    } else {
      if (!isHeld) commits.add(oid);
      // Traverse to parents. With a deepen, walk through held commits
      // too (the wanted tip is itself a have); without one, stop at
      // held commits.
      if (!isHeld || depth > 0) {
        for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
      }
    }
  }
  for (const c of commits) {
    const obj = repo.objects.get(c);
    if (!obj) continue;
    objects.set(c, obj);
    const commit = parseCommit(obj.data);
    collectTree(repo, commit.tree, objects);
  }
  // Include annotated tags pointing at wanted commits.
  for (const [oid, obj] of repo.objects) {
    if (obj.type === "tag") {
      const tag = parseTag(obj.data);
      if (commits.has(tag.object)) objects.set(oid, obj);
    }
  }
  // Never re-send an object the client already holds.
  for (const oid of held) objects.delete(oid);
  return { objects, shallow, unshallow };
}

/**
 * The depth of the deepest client shallow commit, measured from the
 * wants (a want is at depth 1). Returns 0 when no client shallow commit
 * is reachable from the wants. Used to resolve `deepen-relative`: the
 * effective deepen is the relative deepen plus this depth.
 */
export function shallowBoundaryDepth(repo: Repo, wants: string[], clientShallow: string[]): number {
  const targets = new Set(clientShallow);
  if (targets.size === 0) return 0;
  const seen = new Set<string>();
  const queue: [string, number][] = wants.map((w) => [w, 1] as [string, number]);
  let max = 0;
  while (queue.length > 0) {
    const [oid, d] = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (targets.has(oid)) max = Math.max(max, d);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
  }
  return max;
}

/**
 * Every object reachable from the given commit tips (commits, trees, blobs).
 * `boundary` names commits the caller is known to hold as a shallow
 * boundary: they are included (with their trees), but their ancestors are
 * NOT — a shallow clone holds the boundary commit but not its parents.
 */
export function reachableObjects(repo: Repo, tips: string[], boundary: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const commits = new Set<string>();
  for (const tip of tips) {
    const stack = [tip];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || commits.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== "commit") continue;
      commits.add(oid);
      // A boundary commit is held, but its ancestors are not.
      if (boundary.has(oid)) continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  }
  for (const c of commits) {
    out.add(c);
    const obj = repo.objects.get(c);
    if (!obj || obj.type !== "commit") continue;
    collectTreeOids(repo, parseCommit(obj.data).tree, out);
  }
  return out;
}

function collectTreeOids(repo: Repo, treeOid: string, out: Set<string>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== "tree") return;
  out.add(treeOid);
  for (const e of parseTree(obj.data)) {
    const child = repo.objects.get(e.oid);
    if (!child) continue;
    if (child.type === "tree") collectTreeOids(repo, e.oid, out);
    else out.add(e.oid);
  }
}
