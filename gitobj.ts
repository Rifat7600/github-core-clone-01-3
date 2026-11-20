// gitobj.ts — git object ids, parsing and serialisation, delta application.
// Written from the git object format as specified in git's documentation:
// an object is "<type> <size>\0<contents>", its id the SHA-1 of that.
// Only node:crypto and node:zlib are used; no git binary anywhere.

import { createHash } from "node:crypto";

export type ObjType = "commit" | "tree" | "blob" | "tag";

export const ZERO_OID = "0000000000000000000000000000000000000000";

export function objectId(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, "utf8");
  return createHash("sha1").update(head).update(data).digest("hex");
}

export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}

export function isHexOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

// ---------------------------------------------------------------- commits

export interface Commit {
  tree: string;
  parents: string[];
  author: string; // raw "Name <email> ts tz" line
  committer: string;
  message: string;
  extra: string[]; // any other header lines (gpgsig, encoding, ...) kept verbatim
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : "";
  const c: Commit = { tree: "", parents: [], author: "", committer: "", message, extra: [] };
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) c.tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) c.parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) c.author = line.slice(7);
    else if (line.startsWith("committer ")) c.committer = line.slice(10);
    else if (line.length > 0) c.extra.push(line);
  }
  return c;
}

export function serializeCommit(c: Commit): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  for (const e of c.extra) lines.push(e);
  return Buffer.from(lines.join("\n") + "\n\n" + c.message, "utf8");
}

// ------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // e.g. "100644", "40000"
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString("utf8");
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString("utf8");
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------- tags

export interface Tag {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): Tag {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const t: Tag = { object: "", type: "commit", tag: "", tagger: "", message: split >= 0 ? text.slice(split + 2) : "" };
  for (const line of head.split("\n")) {
    if (line.startsWith("object ")) t.object = line.slice(7).trim();
    else if (line.startsWith("type ")) t.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith("tag ")) t.tag = line.slice(4);
    else if (line.startsWith("tagger ")) t.tagger = line.slice(7);
  }
  return t;
}

// ------------------------------------------------------------------ deltas

function readVarint(buf: Buffer, off: number): [number, number] {
  let v = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = buf[i++];
    v |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return [v, i];
}

/** Apply a git delta to its base object. Throws on a malformed delta. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const [srcSize, p1] = readVarint(delta, pos);
  pos = p1;
  const [tgtSize, p2] = readVarint(delta, pos);
  pos = p2;
  if (srcSize !== base.length) throw new Error("delta base size mismatch");
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) off |= delta[pos++] << (8 * b);
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) size |= delta[pos++] << (8 * b);
      if (size === 0) size = 0x10000;
      if (off + size > base.length) throw new Error("delta copy out of range");
      out.push(base.subarray(off, off + size));
      outLen += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      outLen += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  if (outLen !== tgtSize) throw new Error("delta target size mismatch");
  return Buffer.concat(out);
}
