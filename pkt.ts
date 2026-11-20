// pkt.ts — pkt-line framing and side-band-64k, as git's smart HTTP uses.
// A pkt-line is 4 hex digits of the total length (including the 4 digits)
// followed by the payload. "0000" is a flush, "0001" a delimiter and
// "0002" a response-end. Side-band-64k frames a stream as pkt-lines whose
// first payload byte is the band (1 = data, 2 = progress, 3 = error).

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from("0000", "ascii");
export const DELIM = Buffer.from("0001", "ascii");

export interface PktLine {
  kind: "line" | "flush" | "delim" | "end";
  data: Buffer;
}

/** Split a buffer into pkt-lines. Stops at the first malformed line. */
export function parsePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const head = buf.subarray(pos, pos + 4).toString("ascii");
    if (head === "0000") {
      out.push({ kind: "flush", data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (head === "0001") {
      out.push({ kind: "delim", data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (head === "0002") {
      out.push({ kind: "end", data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > buf.length) break;
    out.push({ kind: "line", data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

/** Frame `data` as side-band band-1 pkt-lines (max 65520 bytes each). */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line is at most 65520 bytes total: 4 header + 1 band byte + data.
  const MAX = 65515;
  for (let i = 0; i < data.length; i += MAX) {
    const chunk = data.subarray(i, Math.min(data.length, i + MAX));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) {
    // an empty stream still needs no band-1 lines; the caller adds a flush
  }
  return Buffer.concat(parts);
}

/** Frame text lines as side-band band-1 pkt-lines (for report-status). */
export function sidebandText(lines: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, "utf8")])));
  }
  return Buffer.concat(parts);
}
