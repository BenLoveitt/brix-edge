import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeRoot, configFor, boot, pdfBytes } from "./helpers.mjs";

async function withServer(fn, extraEnv = {}) {
  const { root, map } = makeRoot();
  const cfg = configFor(root, map, extraEnv);
  const s = await boot(cfg);
  try { await fn({ ...s, root, cfg }); } finally { await s.close(); }
}

test("serves the drawing as application/pdf with validators, and no file name anywhere in the response", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/drawings/scr_a`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    assert.ok(/^"sha256:[0-9a-f]{64}"$/.test(r.headers.get("etag")), "content-hash ETag");
    assert.ok(r.headers.get("last-modified"));
    assert.equal(r.headers.get("cache-control"), "no-store");
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(Number(r.headers.get("content-length")), body.length);
    for (const [k, v] of r.headers) assert.ok(!/released\.pdf|44-1187/.test(`${k}:${v}`), `file name leaked in header ${k}`);
  });
});

test("the minute check: If-None-Match with the current ETag is 304 with no body; a changed file is 200 with a new ETag", async () => {
  await withServer(async ({ base, root, metrics }) => {
    const first = await fetch(`${base}/drawings/scr_a`);
    const etag = first.headers.get("etag");
    const same = await fetch(`${base}/drawings/scr_a`, { headers: { "if-none-match": etag } });
    assert.equal(same.status, 304);
    assert.equal((await same.arrayBuffer()).byteLength, 0);
    assert.equal(metrics.notModified, 1);
    // The customer replaces the exact file.
    const p = join(root, "parts", "44-1187", "released.pdf");
    writeFileSync(p, pdfBytes("RELEASED REV C"));
    const future = new Date(Date.now() + 5000);
    utimesSync(p, future, future);
    const changed = await fetch(`${base}/drawings/scr_a`, { headers: { "if-none-match": etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
    assert.ok((await changed.text()).includes("RELEASED REV C"));
  });
});

test("If-Modified-Since alone is honoured, with one-second resolution", async () => {
  await withServer(async ({ base }) => {
    const first = await fetch(`${base}/drawings/scr_b`);
    const lm = first.headers.get("last-modified");
    const r = await fetch(`${base}/drawings/scr_b`, { headers: { "if-modified-since": lm } });
    assert.equal(r.status, 304);
    const older = await fetch(`${base}/drawings/scr_b`, { headers: { "if-modified-since": new Date(2020, 0, 1).toUTCString() } });
    assert.equal(older.status, 200);
  });
});

test("HEAD answers the same headers with no body", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/drawings/scr_a`, { method: "HEAD" });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("etag"));
    assert.equal((await r.arrayBuffer()).byteLength, 0);
  });
});

test("an unknown token is 404 and COUNTED; a canary token is 404 and counted SEPARATELY", async () => {
  await withServer(async ({ base, metrics, logs }) => {
    assert.equal((await fetch(`${base}/drawings/scr_nope`)).status, 404);
    assert.equal(metrics.unknownToken, 1);
    assert.equal(metrics.canary, 0);
    assert.equal((await fetch(`${base}/drawings/scr_canary`)).status, 404);
    assert.equal(metrics.canary, 1);
    assert.ok(logs.some((l) => l.token === "scr_canary" && l.canary === true), "the canary hit is in the access log");
  });
});

test("a station with nothing released is 404 with a reason header, and counted", async () => {
  await withServer(async ({ base, metrics }) => {
    const r = await fetch(`${base}/drawings/scr_empty`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("x-brix-edge-reason"), "nothing-released");
    assert.equal(metrics.noReleased, 1);
  });
});

test("a mapped path outside the root is never served", async () => {
  await withServer(async ({ base, metrics }) => {
    assert.equal((await fetch(`${base}/drawings/scr_dotdot`)).status, 404);
    const esc = await fetch(`${base}/drawings/scr_escape`);
    assert.notEqual(esc.status, 200);
    assert.ok(metrics.outside >= 1);
  });
});

test("an oversize drawing is refused with 413", async () => {
  await withServer(async ({ base, metrics }) => {
    assert.equal((await fetch(`${base}/drawings/scr_a`)).status, 413);
    assert.equal(metrics.tooLarge, 1);
  }, { BRIX_EDGE_MAX_BYTES: "50" });
});

test("only GET and HEAD exist; nothing else is a route", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/drawings/scr_a`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/drawings/scr_a`, { method: "PUT" })).status, 405);
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/drawings/`)).status, 404);
    assert.equal((await fetch(`${base}/parts/44-1187/released.pdf`)).status, 404); // no direct paths
  });
});

test("/healthz and /metrics say what a reviewer needs and nothing more", async () => {
  await withServer(async ({ base }) => {
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.outbound, "none");
    assert.equal(h.mode, "map");
    assert.equal(typeof h.tokensMapped, "number");
    await fetch(`${base}/drawings/scr_a`);
    await fetch(`${base}/drawings/scr_nope`);
    const m = await (await fetch(`${base}/metrics`)).text();
    assert.match(m, /brix_edge_up 1/);
    assert.match(m, /brix_edge_drawings_served_total\{token="scr_a"\} 1/);
    assert.match(m, /brix_edge_unknown_token_total 1/);
    assert.match(m, /brix_edge_canary_requests_total 0/);
    assert.match(m, /brix_edge_last_served_timestamp_seconds\{token="scr_a"\} \d+/);
    assert.ok(!m.includes("released.pdf"), "no file names in metrics");
  });
});

test("the access log carries token, status, bytes and the file name — the customer's record", async () => {
  await withServer(async ({ base, logs }) => {
    await fetch(`${base}/drawings/scr_a`);
    const hit = logs.find((l) => l.token === "scr_a" && l.status === 200);
    assert.ok(hit);
    assert.equal(hit.file, "released.pdf");
    assert.ok(hit.bytes > 0);
    assert.ok(hit.remote);
    assert.ok(hit.ts);
  });
});

test("a malformed percent-escape is a counted 404, and the server keeps serving", async () => {
  await withServer(async ({ base, metrics }) => {
    const bad = await fetch(`${base}/drawings/%E0%A4%A`);
    assert.equal(bad.status, 404);
    assert.equal(metrics.unknownToken, 1);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/drawings/scr_a`)).status, 200);
  });
});

test("an internal error in a request is a 500, not a dead server", async () => {
  const { root, map } = makeRoot();
  const cfg = configFor(root, map);
  // A broken cfg makes resolveToken reject, standing in for any I/O fault
  // (a file removed between stat and read, a share that drops).
  const s = await boot({ ...cfg, map: { get() { throw new Error("boom"); }, size: 1 } });
  try {
    const r = await fetch(`${s.base}/drawings/scr_a`);
    assert.equal(r.status, 500);
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  } finally { await s.close(); }
});

test("identity mode: a case or trailing-dot variant of a canary token is refused and counted as the canary", async () => {
  const { root } = makeRoot();
  const cfg = configFor(root, null, { BRIX_EDGE_CANARY_TOKENS: "canary" });
  const s = await boot(cfg);
  try {
    for (const t of ["CANARY", "Canary", "canary."]) {
      const r = await fetch(`${s.base}/drawings/${t}`);
      assert.equal(r.status, 404, `${t} must not be served`);
      assert.ok(!(await r.text()).includes("CANARY"));
    }
    assert.equal(s.metrics.canary, 3);
    assert.equal((await fetch(`${s.base}/drawings/canary`)).status, 404);
    assert.equal(s.metrics.canary, 4);
    // Positive control: a real station folder still serves.
    mkdirSync(join(root, "station1"));
    writeFileSync(join(root, "station1", "released.pdf"), pdfBytes("S1"));
    assert.equal((await fetch(`${s.base}/drawings/station1`)).status, 200);
  } finally { await s.close(); }
});

test("identity mode: a stray top-level file is never served over HTTP", async () => {
  const { root } = makeRoot();
  writeFileSync(join(root, "hr-notes.txt"), "DUMMY-NON-DRAWING-CONTENT");
  const s = await boot(configFor(root, null));
  try {
    const r = await fetch(`${s.base}/drawings/hr-notes.txt`);
    assert.equal(r.status, 404);
    assert.ok(!(await r.text()).includes("DUMMY"));
    assert.equal((await fetch(`${s.base}/drawings/canary`)).status, 200);
  } finally { await s.close(); }
});
