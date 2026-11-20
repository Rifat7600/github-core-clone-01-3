// main.ts — entrypoint: bind an ephemeral port, register it with the
// trial environment, serve until the environment says done, then exit 0.
// Register and done-polling both use a 30s per-attempt timeout with
// exponential backoff starting at 250ms and doubling to a 2000ms cap.
// A 200 or 409 from /register counts as success; 400/405 is fatal.

import { createAppServer } from "./app.ts";
import { Store } from "./store.ts";

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? "";
if (!ENV_URL) {
  console.error("MAKEFUN_ENV_URL is not set");
  process.exit(1);
}

const TIMEOUT_MS = 30_000;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function register(port: number): Promise<void> {
  let backoff = BASE_BACKOFF_MS;
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const res = await fetchWithTimeout(`${ENV_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      }, TIMEOUT_MS);
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        console.error(`register failed fatally: ${res.status}`);
        process.exit(1);
      }
      console.error(`register attempt ${attempt} got ${res.status}, retrying`);
    } catch (e) {
      console.error(`register attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}, retrying`);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  console.error("register failed after 60 attempts");
  process.exit(1);
}

async function waitDone(): Promise<void> {
  let backoff = BASE_BACKOFF_MS;
  for (;;) {
    try {
      const res = await fetchWithTimeout(`${ENV_URL}/done`, { method: "GET" }, TIMEOUT_MS);
      if (res.status === 200) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
      } else {
        console.error(`done poll got ${res.status}, retrying`);
      }
    } catch (e) {
      console.error(`done poll failed: ${e instanceof Error ? e.message : String(e)}, retrying`);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createAppServer(store);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    console.error("could not determine listen port");
    process.exit(1);
  }
  const port = address.port;
  console.log(`forge listening on 127.0.0.1:${port}`);
  await register(port);
  console.log("registered");
  await waitDone();
  console.log("done, shutting down");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
