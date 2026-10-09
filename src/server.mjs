/**
 * The HTTP surface. Three routes and nothing else:
 *
 *   GET|HEAD /drawings/<token>   the station's current drawing (PDF), with the
 *                               validators the screen uses to ask "still the
 *                               same?" every minute: ETag (content hash) and
 *                               Last-Modified. A conditional request that
 *                               matches is answered 304 with no body.
 *   GET      /healthz            liveness, and how many tokens are mapped
 *   GET      /metrics            Prometheus text (see metrics.mjs)
 *
 * WHAT IT NEVER DOES. It opens no outbound connection — there is no HTTP
 * client, no DNS lookup, no push of any kind in this program (test/no-egress
 * .test.mjs pins that at the source level). It never reveals a file name to a
 * client: the screen gets bytes and validators, and the name appears only in
 * YOUR access log. It never lists a folder to a client, and it never serves a
 * path outside the root.
 *
 * THE ACCESS LOG is one JSON line per request on stdout — time, remote
 * address, token, status, bytes, and the file that was served. Ship it to
 * your SIEM: it is the record of every read, written by software you run.
 */
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { resolveToken } from "./resolve.mjs";
import { Metrics } from "./metrics.mjs";

const VERSION = "0.1.0";

/** Content hashes, keyed by path+size+mtime so a replaced file is re-hashed
 *  and an unchanged one is not re-read on every minute check. */
const etagCache = new Map();
async function etagFor(file) {
  const key = `${file.path}|${file.size}|${file.mtimeMs}`;
  const hit = etagCache.get(key);
  if (hit) return hit;
  const h = createHash("sha256");
  await new Promise((res, rej) => createReadStream(file.path).on("data", (c) => h.update(c)).on("end", res).on("error", rej));
  const etag = `"sha256:${h.digest("hex")}"`;
  // Bounded: a folder that churns forever must not grow this without limit.
  if (etagCache.size > 4096) etagCache.clear();
  etagCache.set(key, etag);
  return etag;
}

function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(",").map((s) => s.trim().replace(/^W\//, "")).some((s) => s === "*" || s === etag);
}

function notModifiedSince(header, mtimeMs) {
  if (!header) return false;
  const since = Date.parse(header);
  if (!Number.isFinite(since)) return false;
  // HTTP dates have one-second resolution.
  return Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000);
}

/** The canary check's view of a token: case folded and trailing dots
 *  stripped, the two ways a Windows or macOS filesystem would still open the
 *  canary's folder for a name that is not byte-for-byte the canary token. */
const canaryKey = (t) => t.toLowerCase().replace(/\.+$/, "");

export function createEdgeServer(cfg, { log = defaultLog, metrics = new Metrics() } = {}) {
  const canaryKeys = new Set([...cfg.canary].map(canaryKey));
  // An async listener that rejects is an unhandled rejection, and Node exits
  // on those: one malformed request would stop the service for every station.
  // Every error ends as a 500 for that one request instead.
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) { res.writeHead(500, { "content-length": "0", "cache-control": "no-store" }); res.end(); }
        else res.destroy();
      } catch { /* gone */ }
      metrics.request("other", 500);
      log({ ts: new Date().toISOString(), remote: req.socket.remoteAddress ?? "", method: req.method, path: req.url, status: 500, reason: "internal", error: String(err?.message ?? err) });
    });
  });
  async function handle(req, res) {
    const t0 = Date.now();
    const url = new URL(req.url ?? "/", "http://edge");
    const remote = req.socket.remoteAddress ?? "";
    const done = (status, extra = {}) => {
      log({ ts: new Date().toISOString(), remote, method: req.method, path: url.pathname, status, ms: Date.now() - t0, ...extra });
    };
    const json = (status, body, route) => {
      metrics.request(route, status);
      const buf = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(buf.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : buf);
      done(status);
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      metrics.request("other", 405);
      res.writeHead(405, { allow: "GET, HEAD", "content-length": "0" }); res.end(); done(405); return;
    }

    if (url.pathname === "/healthz") {
      return json(200, { ok: true, version: VERSION, tokensMapped: cfg.map ? cfg.map.size : 0, mode: cfg.map ? "map" : "identity", outbound: "none" }, "healthz");
    }
    if (url.pathname === "/metrics") {
      metrics.request("metrics", 200);
      const body = metrics.render({ tokensMapped: cfg.map ? cfg.map.size : 0 });
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": String(Buffer.byteLength(body)), "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body); done(200); return;
    }

    const m = /^\/drawings\/([^/]+)\/?$/.exec(url.pathname);
    if (!m) return json(404, { error: "not_found" }, "other");
    let token;
    try { token = decodeURIComponent(m[1]); }
    catch {
      // A malformed escape can name no station: it is an unknown token.
      metrics.unknownToken++; metrics.request("drawing", 404);
      res.writeHead(404, { "content-length": "0", "cache-control": "no-store" }); res.end();
      done(404, { reason: "bad_encoding" }); return;
    }

    // The canary: a token that exists in the map so that a request for it
    // resolves like any other — but that no screen was ever given. Any
    // request is an alarm, whoever made it.
    if (canaryKeys.has(canaryKey(token))) {
      metrics.canary++;
      metrics.request("drawing", 404);
      res.writeHead(404, { "content-length": "0", "cache-control": "no-store" }); res.end();
      done(404, { token, canary: true }); return;
    }

    const r = await resolveToken(cfg, token);
    switch (r.kind) {
      case "unknown":
        metrics.unknownToken++; metrics.request("drawing", 404);
        res.writeHead(404, { "content-length": "0", "cache-control": "no-store" }); res.end();
        done(404, { token, reason: "unknown_token" }); return;
      case "outside":
        metrics.outside++; metrics.request("drawing", 404);
        res.writeHead(404, { "content-length": "0", "cache-control": "no-store" }); res.end();
        done(404, { token, reason: "outside_root" }); return;
      case "nothing-released":
        metrics.noReleased++; metrics.request("drawing", 404);
        res.writeHead(404, { "content-length": "0", "cache-control": "no-store", "x-brix-edge-reason": "nothing-released" }); res.end();
        done(404, { token, reason: "nothing_released" }); return;
      case "too-large":
        metrics.tooLarge++; metrics.request("drawing", 413);
        res.writeHead(413, { "content-length": "0", "cache-control": "no-store" }); res.end();
        done(413, { token, reason: "too_large", size: r.size }); return;
      case "file": break;
      default: return json(500, { error: "internal" }, "drawing");
    }

    const etag = await etagFor(r);
    const lastModified = new Date(r.mtimeMs).toUTCString();
    const headers = {
      "content-type": "application/pdf",
      etag,
      "last-modified": lastModified,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    };
    if (etagMatches(req.headers["if-none-match"], etag) || (!req.headers["if-none-match"] && notModifiedSince(req.headers["if-modified-since"], r.mtimeMs))) {
      metrics.notModified++; metrics.request("drawing", 304);
      res.writeHead(304, headers); res.end();
      done(304, { token, file: r.name, etag }); return;
    }
    metrics.request("drawing", 200);
    res.writeHead(200, { ...headers, "content-length": String(r.size) });
    if (req.method === "HEAD") { res.end(); done(200, { token, file: r.name, etag, bytes: 0 }); return; }
    const stream = createReadStream(r.path);
    stream.on("error", () => { try { res.destroy(); } catch { /* gone */ } done(500, { token, file: r.name, reason: "read_error" }); });
    stream.on("end", () => { metrics.servedDrawing(token, r.size); done(200, { token, file: r.name, etag, bytes: r.size }); });
    stream.pipe(res);
  }
  server.metrics = metrics;
  return server;
}

/** One JSON line per request on stdout. Your log shipper does the rest. */
export function defaultLog(entry) {
  process.stdout.write(JSON.stringify(entry) + "\n");
}

/**
 * `verify`: what an operator (or a scheduled check) runs to prove the server
 * is configured to serve every station, and nothing else. Exit 0 = every
 * mapped token resolves to a document or is a declared canary; exit 1 = the
 * root or map is broken; exit 2 = some station has nothing released.
 */
export async function verify(cfg) {
  const rows = [];
  // Severity: a BROKEN mapping (outside the root, unknown) outranks a station
  // with nothing released. Exit codes: 1 broken, 2 nothing released, 0 clean.
  let broken = false;
  let missing = false;
  const tokens = cfg.map ? [...cfg.map.keys()] : [];
  for (const token of tokens) {
    if (cfg.canary.has(token)) { rows.push({ token, status: "canary", note: "must never be requested" }); continue; }
    const r = await resolveToken(cfg, token);
    if (r.kind === "file") rows.push({ token, status: "ok", bytes: r.size, modified: new Date(r.mtimeMs).toISOString() });
    else { rows.push({ token, status: r.kind }); if (r.kind === "nothing-released") missing = true; else broken = true; }
  }
  for (const c of cfg.canary) if (!cfg.map || !cfg.map.has(c)) rows.push({ token: c, status: "canary", note: "not in map — a request 404s and is still counted" });
  await fs.access(cfg.root);
  return { root: cfg.root, mode: cfg.map ? "map" : "identity", releasedName: cfg.releasedName, maxBytes: cfg.maxBytes, outbound: "none", rows, exitCode: broken ? 1 : missing ? 2 : 0 };
}
