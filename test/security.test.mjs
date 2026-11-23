/**
 * Regression tests for the 2026-11-23 security review. Each test names the
 * attack it stops. SECURITY.md maps every claim to the test that enforces it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { writeFileSync, renameSync, symlinkSync, unlinkSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRoot, configFor, boot, pdfBytes } from "./helpers.mjs";
import { resolveToken, openDrawing } from "../src/resolve.mjs";
import { createEdgeServer, hostAllowed, DEFAULT_LIMITS } from "../src/server.mjs";
import { parseHostnames } from "../src/config.mjs";

/** GET with an explicit Host header (fetch() does not let a caller set Host). */
function get(base, path, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: "GET", headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("DNS rebinding: a request whose Host names some other site is refused with 421 and counted", async () => {
  const { root, map } = makeRoot();
  const s = await boot(configFor(root, map, { BRIX_EDGE_HOSTNAMES: "edge-01,.corp.example.com" }));
  try {
    for (const host of ["attacker.example", "attacker.example:8787", "edge.corp.example.com.attacker.example", "corp.example.com.", "local", "x.internal.attacker.example"]) {
      const r = await get(s.base, "/drawings/scr_a", { host });
      assert.equal(r.status, 421, `Host ${host} must be refused`);
      assert.equal(r.body.length, 0);
    }
    assert.equal((await get(s.base, "/metrics", { host: "attacker.example" })).status, 421, "/metrics is behind the same check");
    assert.equal(s.metrics.refusedHost, 7);
    assert.ok(s.logs.some((l) => l.status === 421 && l.reason === "host_not_allowed" && l.host === "attacker.example"));
    // Positive controls: the addresses a screen really uses.
    for (const host of ["10.50.0.12", "10.50.0.12:8787", "[fd00::12]:8787", "localhost:8787", "brix-edge.plant.local", "edge.internal", "edge.home.arpa", "EDGE-01", "edge.corp.example.com", "Edge.Corp.Example.Com.:8787"]) {
      const r = await get(s.base, "/drawings/scr_a", { host });
      assert.equal(r.status, 200, `Host ${host} must be served`);
      assert.equal(r.body.subarray(0, 5).toString("latin1"), "%PDF-");
    }
  } finally { await s.close(); }
});

test("hostAllowed: names, literals and the configured list", () => {
  const allowed = parseHostnames("edge-01, .corp.example.com");
  assert.equal(hostAllowed(undefined, allowed), true, "HTTP/1.0 without Host");
  assert.equal(hostAllowed("192.168.1.20", allowed), true);
  assert.equal(hostAllowed("999.1.1.1", allowed), false);
  assert.equal(hostAllowed("[::1]", allowed), true);
  assert.equal(hostAllowed("[::1]x", allowed), false);
  assert.equal(hostAllowed("evil.example", allowed), false);
  assert.equal(hostAllowed(".local", allowed), false, "a bare suffix is not a name");
  assert.equal(hostAllowed("", allowed), false);
  assert.throws(() => parseHostnames("bad host"), /not a host name/);
});

test("/metrics and /healthz carry no token: a prober cannot read the list of valid screen ids", async () => {
  const { root, map } = makeRoot();
  const s = await boot(configFor(root, map));
  try {
    await fetch(`${s.base}/drawings/scr_a`);
    await fetch(`${s.base}/drawings/scr_b`);
    const text = (await (await fetch(`${s.base}/metrics`)).text()) + (await (await fetch(`${s.base}/healthz`)).text());
    for (const t of ["scr_a", "scr_b", "scr_file", "scr_empty", "scr_canary", "parts", "44-1187"]) assert.ok(!text.includes(t), `${t} must not appear`);
  } finally { await s.close(); }
});

test("slowloris: the default limits are short, and a client that never finishes its headers is cut off", async () => {
  const { root, map } = makeRoot();
  const cfg = configFor(root, map);
  const real = createEdgeServer(cfg, { log: () => {} });
  assert.ok(real.headersTimeout <= 10_000, `headersTimeout ${real.headersTimeout}`);
  assert.ok(real.requestTimeout <= 30_000, `requestTimeout ${real.requestTimeout}`);
  assert.ok(real.timeout > 0 && real.timeout <= 60_000, `idle timeout ${real.timeout}`);
  assert.equal(real.maxConnections, 512);
  assert.equal(real.maxHeadersCount, 64);
  assert.equal(DEFAULT_LIMITS.checkIntervalMs, 1_000);

  const server = createEdgeServer(cfg, { log: () => {}, limits: { headersTimeoutMs: 300, requestTimeoutMs: 400, checkIntervalMs: 100 } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const sock = connect(server.address().port, "127.0.0.1");
    await new Promise((r) => sock.on("connect", r));
    sock.write("GET /drawings/scr_a HTTP/1.1\r\nHost: 127.0.0.1\r\n"); // never the blank line
    const t0 = Date.now();
    const closed = await Promise.race([
      new Promise((r) => { sock.on("close", () => r(true)); sock.on("error", () => r(true)); sock.resume(); }),
      new Promise((r) => setTimeout(() => r(false), 3000))
    ]);
    sock.destroy();
    assert.ok(closed, "the half-open request must be closed by the server");
    assert.ok(Date.now() - t0 < 3000);
  } finally { await new Promise((r) => server.close(r)); }
});

test("BRIX_EDGE_MAX_CONNECTIONS sets the connection cap", () => {
  const { root, map } = makeRoot();
  const s = createEdgeServer(configFor(root, map, { BRIX_EDGE_MAX_CONNECTIONS: "40" }), { log: () => {} });
  assert.equal(s.maxConnections, 40);
});

test("check-then-open race: a drawing swapped for a symlink out of the root after the check is not opened", async (t) => {
  const { root, map, outside } = makeRoot();
  const cfg = configFor(root, map);
  const r = await resolveToken(cfg, "scr_a");
  assert.equal(r.kind, "file");
  // Someone with write access to the share swaps the file between check and open.
  unlinkSync(r.path);
  try { symlinkSync(join(outside, "secret.pdf"), r.path); } catch { t.skip("no symlinks on this filesystem"); return; }
  const o = await openDrawing(cfg, r);
  assert.equal(o.kind, "outside");
});

test("check-then-open race: a drawing swapped for a FIFO is not opened, and nothing hangs", async (t) => {
  if (process.platform === "win32") { t.skip("no mkfifo on Windows"); return; }
  const { root, map } = makeRoot();
  const cfg = configFor(root, map);
  const r = await resolveToken(cfg, "scr_a");
  unlinkSync(r.path);
  try { execFileSync("mkfifo", [r.path]); } catch { t.skip("mkfifo not available"); return; }
  const o = await Promise.race([openDrawing(cfg, r), new Promise((res) => setTimeout(() => res({ kind: "hung" }), 2000))]);
  assert.equal(o.kind, "nothing-released");
});

test("the body is exactly the bytes the ETag describes: hashed and sent from one open descriptor", async (t) => {
  // Windows refuses to rename over a file that is open, so there the swap
  // cannot happen at all.
  if (process.platform === "win32") { t.skip("Windows does not replace an open file"); return; }
  const { root, map } = makeRoot();
  const cfg = configFor(root, map);
  const r = await resolveToken(cfg, "scr_a");
  const o = await openDrawing(cfg, r);
  assert.equal(o.kind, "open");
  // The file is replaced (rename over it) after the open: the open descriptor still reads the old bytes.
  const tmp = `${r.path}.tmp`;
  writeFileSync(tmp, pdfBytes("A MUCH LONGER REPLACEMENT DRAWING THAT CHANGES THE SIZE"));
  renameSync(tmp, r.path);
  const chunks = [];
  for await (const c of o.fh.createReadStream({ start: 0, end: o.size - 1 })) chunks.push(c);
  const body = Buffer.concat(chunks);
  assert.equal(body.length, o.size);
  assert.ok(body.toString("latin1").includes("RELEASED"));
});

test("two hundred screens asking at once after a change cost one read of the file", async () => {
  const { root, map } = makeRoot();
  const s = await boot(configFor(root, map));
  try {
    const res = await Promise.all(Array.from({ length: 200 }, () => fetch(`${s.base}/drawings/scr_a`, { method: "HEAD" })));
    assert.ok(res.every((r) => r.status === 200));
    assert.equal(new Set(res.map((r) => r.headers.get("etag"))).size, 1);
    assert.equal(s.metrics.hashReads, 1);
  } finally { await s.close(); }
});

test("If-Modified-Since: a newer drawing copied in with an OLDER modification time is still sent", async () => {
  const { root, map } = makeRoot();
  const s = await boot(configFor(root, map));
  try {
    const first = await fetch(`${s.base}/drawings/scr_a`);
    const lm = first.headers.get("last-modified");
    await new Promise((r) => setTimeout(r, 1100)); // HTTP dates have one-second resolution
    // robocopy / rsync -t: the new revision keeps its source's (older) time.
    const p = join(root, "parts", "44-1187", "released.pdf");
    writeFileSync(`${p}.new`, pdfBytes("REV D, OLD TIMESTAMP"));
    utimesSync(`${p}.new`, new Date(2025, 0, 1), new Date(2025, 0, 1));
    renameSync(`${p}.new`, p);
    const again = await fetch(`${s.base}/drawings/scr_a`, { headers: { "if-modified-since": lm } });
    assert.equal(again.status, 200, "a replaced drawing must not be answered 'not modified'");
    assert.ok((await again.text()).includes("REV D"));
  } finally { await s.close(); }
});

test("the station map is re-read when it changes; a broken map is refused and the old one stays", async () => {
  const { root, map } = makeRoot();
  const cfg = configFor(root, map);
  const logs = [];
  const server = createEdgeServer(cfg, { log: (e) => logs.push(e), limits: { mapCheckMs: 0 } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/drawings/scr_new`)).status, 404);
    const m = JSON.parse(readFileSync(map, "utf8"));
    writeFileSync(map, JSON.stringify({ ...m, scr_new: "parts/44-1190" }));
    assert.equal((await fetch(`${base}/drawings/scr_new`)).status, 200);
    assert.equal(server.metrics.mapReloads, 1);
    writeFileSync(map, "{ not json");
    assert.equal((await fetch(`${base}/drawings/scr_new`)).status, 200, "the last good map stays in use");
    assert.equal(server.metrics.mapReloadErrors, 1);
    assert.ok(logs.some((l) => l.event === "map_refused"));
  } finally { await new Promise((r) => server.close(r)); }
});

test("a drawing response says it takes no ranges, and never names the file", async () => {
  const { root, map } = makeRoot();
  const s = await boot(configFor(root, map));
  try {
    const r = await fetch(`${s.base}/drawings/scr_a`, { headers: { range: "bytes=0-10" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("accept-ranges"), "none");
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.length, Number(r.headers.get("content-length")));
    for (const [k, v] of r.headers) assert.ok(!/released|44-1187|parts/.test(`${k}:${v}`), `${k} leaks a name`);
  } finally { await s.close(); }
});
