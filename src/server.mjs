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
 * Every route first checks the Host header (see hostAllowed): a web page that
 * re-points its own name at this server (DNS rebinding) carries its own name
 * in Host, and is refused with 421 before any file is looked at.
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
import { promises as fs, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolveToken, openDrawing } from "./resolve.mjs";
import { Metrics, stationLabel } from "./metrics.mjs";
import { readStationMap, PRIVATE_NAME_SUFFIXES } from "./config.mjs";

export const VERSION = "0.2.0";

/** Time limits on each connection. A client that sends its headers slowly
 *  (slowloris), or that stops reading a body, holds a socket and a file; these
 *  bound how long. A screen fetches a few KB to a few MB on a LAN. */
export const DEFAULT_LIMITS = {
  headersTimeoutMs: 10_000,     // the whole request head must arrive within this
  requestTimeoutMs: 30_000,     // the whole request (GET has no body) within this
  idleTimeoutMs: 60_000,        // a socket with no progress either way is closed
  keepAliveTimeoutMs: 5_000,
  checkIntervalMs: 1_000,       // how often Node enforces the two timeouts above
  maxHeadersCount: 64,
  mapCheckMs: 2_000             // how often a changed station map is looked for
};

/** Content hashes, keyed by device, inode, size and both times, so a replaced
 *  file is re-hashed and an unchanged one is not re-read on every check. Two
 *  hundred screens that ask at once after a change share one read. */
const etagCache = new Map();
const etagInFlight = new Map();
async function etagFor(open, metrics) {
  const key = `${open.dev}:${open.ino}:${open.size}:${open.mtimeMs}:${open.ctimeMs}`;
  const hit = etagCache.get(key);
  if (hit) return hit;
  const pending = etagInFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    metrics.hashReads++;
    const h = createHash("sha256");
    if (open.size > 0) {
      await new Promise((res, rej) => open.fh.createReadStream({ start: 0, end: open.size - 1, autoClose: false })
        .on("data", (c) => h.update(c)).on("end", res).on("error", rej));
    }
    const etag = `"sha256:${h.digest("hex")}"`;
    // Bounded: a folder that churns forever must not grow this without limit.
    if (etagCache.size > 4096) etagCache.clear();
    etagCache.set(key, etag);
    return etag;
  })();
  etagInFlight.set(key, p);
  try { return await p; } finally { etagInFlight.delete(key); }
}

function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(",").map((s) => s.trim().replace(/^W\//, "")).some((s) => s === "*" || s === etag);
}

function notModifiedSince(header, lastModifiedMs) {
  if (!header) return false;
  const since = Date.parse(header);
  if (!Number.isFinite(since)) return false;
  // HTTP dates have one-second resolution.
  return Math.floor(lastModifiedMs / 1000) <= Math.floor(since / 1000);
}

/** The canary check's view of a token: case folded and trailing dots
 *  stripped, the two ways a Windows or macOS filesystem would still open the
 *  canary's folder for a name that is not byte-for-byte the canary token. */
const canaryKey = (t) => t.toLowerCase().replace(/\.+$/, "");

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * May a request with this Host header be answered?
 *
 * DNS REBINDING: a web page at attacker.example re-points its own name at this
 * server's address. The browser then treats this server as attacker.example,
 * same origin, and the page can read what it serves. The one thing the page
 * cannot change is the Host header: it is still "attacker.example". So a Host
 * that names something this server is not called is refused.
 *
 * Accepted: no Host at all (HTTP/1.0), an IPv4 or bracketed IPv6 literal,
 * localhost, a name ending .local, .internal or .home.arpa (the private names
 * the screen's own address gate accepts; nobody can register them on the
 * internet), and the names in BRIX_EDGE_HOSTNAMES. A port is ignored.
 */
export function hostAllowed(host, allowed = { exact: new Set(), suffixes: [] }) {
  if (host === undefined) return true;
  let h = String(host).trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0) return false;
    const rest = h.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return false;
    return /^[0-9a-f:.]+$/.test(h.slice(1, end)) && h.includes(":");
  }
  h = h.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (!h || h.includes(":")) return false;
  if (IPV4.test(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (allowed.exact.has(h)) return true;
  for (const suf of [...PRIVATE_NAME_SUFFIXES, ...allowed.suffixes]) if (h.endsWith(suf) && h.length > suf.length) return true;
  return false;
}

export function createEdgeServer(cfg, { log = defaultLog, metrics = new Metrics(), limits = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const canaryKeys = new Set([...cfg.canary].map(canaryKey));
  const allowedHosts = cfg.hostnames ?? { exact: new Set(), suffixes: [] };
  // The configuration this server uses. Only `map` changes, and only to a
  // map that passed the same checks as the one read at start.
  const live = { ...cfg };
  let mapStamp = null;
  let mapCheckedAt = Date.now();
  const stampOf = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  if (cfg.mapPath) { try { mapStamp = stampOf(statSync(cfg.mapPath)); } catch { /* checked on the next request */ } }

  /** Re-read the station map when its file changed. A map that fails the
   *  checks is refused, logged and counted; the previous map stays in use. */
  async function refreshMap() {
    if (!live.mapPath || Date.now() - mapCheckedAt < L.mapCheckMs) return;
    mapCheckedAt = Date.now();
    let st;
    try { st = await fs.stat(live.mapPath); } catch { return; }
    const stamp = stampOf(st);
    if (mapStamp === null) { mapStamp = stamp; return; }
    if (stamp === mapStamp) return;
    mapStamp = stamp;
    try {
      live.map = readStationMap(live.mapPath);
      metrics.mapReloads++;
      log({ ts: new Date().toISOString(), event: "map_reloaded", tokensMapped: live.map.size });
    } catch (e) {
      metrics.mapReloadErrors++;
      log({ ts: new Date().toISOString(), event: "map_refused", error: String(e?.message ?? e), tokensMapped: live.map?.size ?? 0 });
    }
  }

  // An async listener that rejects is an unhandled rejection, and Node exits
  // on those: one malformed request would stop the service for every station.
  // Every error ends as a 500 for that one request instead.
  const server = createServer({
    headersTimeout: L.headersTimeoutMs,
    requestTimeout: L.requestTimeoutMs,
    keepAliveTimeout: L.keepAliveTimeoutMs,
    connectionsCheckingInterval: L.checkIntervalMs,
    maxHeaderSize: 8192
  }, (req, res) => {
    handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) { res.writeHead(500, { "content-length": "0", "cache-control": "no-store" }); res.end(); }
        else res.destroy();
      } catch { /* gone */ }
      metrics.request("other", 500);
      log({ ts: new Date().toISOString(), remote: req.socket.remoteAddress ?? "", method: req.method, path: String(req.url ?? "").slice(0, 512), status: 500, reason: "internal", error: String(err?.message ?? err) });
    });
  });
  server.maxHeadersCount = L.maxHeadersCount;
  server.maxConnections = cfg.maxConnections ?? 512;
  server.setTimeout(L.idleTimeoutMs, (socket) => socket.destroy());

  const empty = (res, status, extra = {}) => {
    res.writeHead(status, { "content-length": "0", "cache-control": "no-store", ...extra }); res.end();
  };

  async function handle(req, res) {
    const t0 = Date.now();
    const url = new URL(req.url ?? "/", "http://edge");
    const remote = req.socket.remoteAddress ?? "";
    const done = (status, extra = {}) => {
      log({ ts: new Date().toISOString(), remote, method: req.method, path: url.pathname.slice(0, 512), status, ms: Date.now() - t0, ...extra });
    };
    const json = (status, body, route) => {
      metrics.request(route, status);
      const buf = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(buf.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : buf);
      done(status);
    };

    if (!hostAllowed(req.headers.host, allowedHosts)) {
      metrics.refusedHost++; metrics.request("other", 421);
      empty(res, 421, { connection: "close" });
      done(421, { reason: "host_not_allowed", host: String(req.headers.host).slice(0, 255) }); return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      metrics.request("other", 405);
      empty(res, 405, { allow: "GET, HEAD" }); done(405); return;
    }

    await refreshMap();
    const mode = live.map ? "map" : "identity";
    const tokensMapped = live.map ? live.map.size : 0;

    if (url.pathname === "/healthz") {
      return json(200, { ok: true, version: VERSION, tokensMapped, mode, outbound: "none" }, "healthz");
    }
    if (url.pathname === "/metrics") {
      metrics.request("metrics", 200);
      const body = metrics.render({ tokensMapped, version: VERSION, mode });
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": String(Buffer.byteLength(body)), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : body); done(200); return;
    }

    const m = /^\/drawings\/([^/]+)\/?$/.exec(url.pathname);
    if (!m) return json(404, { error: "not_found" }, "other");
    let token;
    try { token = decodeURIComponent(m[1]); }
    catch {
      // A malformed escape can name no station: it is an unknown token.
      metrics.unknownToken++; metrics.request("drawing", 404);
      empty(res, 404); done(404, { reason: "bad_encoding" }); return;
    }

    // The canary: a token that exists in the map so that a request for it
    // resolves like any other — but that no screen was ever given. Any
    // request is an alarm, whoever made it.
    if (canaryKeys.has(canaryKey(token))) {
      metrics.canary++; metrics.request("drawing", 404);
      empty(res, 404); done(404, { token, canary: true }); return;
    }

    const refuse = (kind, size) => {
      switch (kind) {
        case "unknown":
          metrics.unknownToken++; metrics.request("drawing", 404);
          empty(res, 404); done(404, { token, reason: "unknown_token" }); return;
        case "outside":
          metrics.outside++; metrics.request("drawing", 404);
          empty(res, 404); done(404, { token, reason: "outside_root" }); return;
        case "nothing-released":
          metrics.noReleased++; metrics.request("drawing", 404);
          empty(res, 404, { "x-brix-edge-reason": "nothing-released" }); done(404, { token, reason: "nothing_released" }); return;
        case "too-large":
          metrics.tooLarge++; metrics.request("drawing", 413);
          empty(res, 413); done(413, { token, reason: "too_large", size }); return;
        default:
          json(500, { error: "internal" }, "drawing");
      }
    };

    const r = await resolveToken(live, token);
    if (r.kind !== "file") return refuse(r.kind, r.size);
    const open = await openDrawing(live, r);
    if (open.kind !== "open") return refuse(open.kind, open.size);

    let handedOff = false;
    try {
      const etag = await etagFor(open, metrics);
      // Last-Modified is the later of the content time and the change time. A
      // copy tool that keeps the source's time (robocopy, rsync -t) can put a
      // NEWER drawing in place with an OLDER modification time; the change
      // time still moves, so a client that only sends If-Modified-Since is
      // not told "unchanged" about a file that was replaced.
      const lastModifiedMs = Math.max(open.mtimeMs, open.ctimeMs);
      const headers = {
        "content-type": "application/pdf",
        etag,
        "last-modified": new Date(lastModifiedMs).toUTCString(),
        "cache-control": "no-store",
        "accept-ranges": "none",
        "x-content-type-options": "nosniff"
      };
      const inm = req.headers["if-none-match"];
      if (etagMatches(inm, etag) || (!inm && notModifiedSince(req.headers["if-modified-since"], lastModifiedMs))) {
        metrics.notModified++; metrics.request("drawing", 304);
        res.writeHead(304, headers); res.end();
        done(304, { token, file: open.name, etag }); return;
      }
      metrics.request("drawing", 200);
      res.writeHead(200, { ...headers, "content-length": String(open.size) });
      if (req.method === "HEAD" || open.size === 0) {
        res.end(); done(200, { token, file: open.name, etag, bytes: 0 }); return;
      }
      // Exactly `size` bytes from the descriptor that was checked and hashed.
      const stream = open.fh.createReadStream({ start: 0, end: open.size - 1, autoClose: true });
      handedOff = true;
      stream.on("error", () => { try { res.destroy(); } catch { /* gone */ } done(500, { token, file: open.name, reason: "read_error" }); });
      stream.on("end", () => { metrics.servedDrawing(token, open.size); done(200, { token, file: open.name, etag, bytes: open.size }); });
      res.on("close", () => { if (!stream.destroyed) stream.destroy(); });
      stream.pipe(res);
    } finally {
      if (!handedOff) await open.fh.close().catch(() => {});
    }
  }
  server.metrics = metrics;
  server.live = live;
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
    const label = stationLabel(token);
    if (r.kind === "file") rows.push({ token, label, status: "ok", bytes: r.size, modified: new Date(r.mtimeMs).toISOString() });
    else { rows.push({ token, label, status: r.kind }); if (r.kind === "nothing-released") missing = true; else broken = true; }
  }
  for (const c of cfg.canary) if (!cfg.map || !cfg.map.has(c)) rows.push({ token: c, status: "canary", note: "not in map — a request 404s and is still counted" });
  await fs.access(cfg.root);
  const hosts = ["IP addresses", "localhost", ...PRIVATE_NAME_SUFFIXES.map((s) => `*${s}`), ...(cfg.hostnames ? [...cfg.hostnames.exact, ...cfg.hostnames.suffixes.map((s) => `*${s}`)] : [])];
  return { version: VERSION, root: cfg.root, mode: cfg.map ? "map" : "identity", releasedName: cfg.releasedName, maxBytes: cfg.maxBytes, hosts, outbound: "none", rows, exitCode: broken ? 1 : missing ? 2 : 0 };
}
