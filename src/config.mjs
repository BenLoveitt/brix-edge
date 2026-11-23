/**
 * Configuration — environment only, so what the container does is visible in
 * the `docker run` line and nowhere else.
 *
 *   BRIX_EDGE_ROOT            the folder holding the drawings (required)
 *   BRIX_EDGE_MAP             JSON file: { "<screen token>": "<folder or file under ROOT>" }
 *                             Absent = IDENTITY mode: the token IS a folder name under ROOT.
 *                             The file is re-read when it changes (checked at most every 2 s).
 *   BRIX_EDGE_CANARY_TOKENS   comma-separated tokens that no screen is ever given.
 *                             A request for one is an alarm, not a 404.
 *   BRIX_EDGE_RELEASED_NAME   the file that wins inside a folder when present (default released.pdf);
 *                             otherwise the newest *.pdf by modification time is served.
 *   BRIX_EDGE_MAX_BYTES       refuse a drawing larger than this (default 32 MiB — the screen's own cap)
 *   BRIX_EDGE_HOSTNAMES       extra names a request may carry in its Host header, comma-separated.
 *                             ".corp.example.com" (leading dot) accepts every name under it.
 *                             IP addresses, localhost and names ending .local, .internal or
 *                             .home.arpa are always accepted. Any other Host is refused with
 *                             421: that is what stops a DNS-rebinding web page.
 *   BRIX_EDGE_MAX_CONNECTIONS how many client connections at once (default 512)
 *   BRIX_EDGE_BIND / _PORT    where to listen (default 0.0.0.0:8787)
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** A token starts with a letter or digit, so "." and ".." can never be one —
 *  the root check would catch them anyway; this refuses them a step earlier. */
export const TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Names that are always accepted in the Host header: the same private-name
 *  suffixes the screen's own address gate accepts. */
export const PRIVATE_NAME_SUFFIXES = [".local", ".internal", ".home.arpa"];

/** Read and check the station map. Throws with the reason; one bad entry
 *  rejects the whole file, because a half-applied map is worse than none. */
export function readStationMap(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(resolve(path), "utf8")); }
  catch (e) { throw new Error(`BRIX_EDGE_MAP is not readable JSON: ${path} (${e.message})`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("BRIX_EDGE_MAP must be a JSON object of token → path");
  const map = new Map();
  for (const [token, target] of Object.entries(raw)) {
    if (token.startsWith("_")) continue; // "_comment" and friends
    if (!TOKEN_SHAPE.test(token)) throw new Error(`BRIX_EDGE_MAP: token ${JSON.stringify(token)} is not a valid token (letters, digits, . _ - only)`);
    if (typeof target !== "string" || !target) throw new Error(`BRIX_EDGE_MAP: token ${token} must map to a path string`);
    map.set(token, target);
  }
  return map;
}

/** "a.example, .corp.example" → { exact: Set, suffixes: [] }, lower-cased. */
export function parseHostnames(value) {
  const exact = new Set();
  const suffixes = [];
  for (const raw of String(value ?? "").split(",")) {
    const h = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!h) continue;
    if (!/^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) {
      throw new Error(`BRIX_EDGE_HOSTNAMES: ${JSON.stringify(raw.trim())} is not a host name`);
    }
    if (h.startsWith(".")) suffixes.push(h); else exact.add(h);
  }
  return { exact, suffixes };
}

export function loadConfig(env = process.env) {
  const root = env.BRIX_EDGE_ROOT;
  if (!root) throw new Error("BRIX_EDGE_ROOT is required: the folder that holds the drawings");
  const rootAbs = resolve(root);
  let rootStat;
  try { rootStat = statSync(rootAbs); } catch { throw new Error(`BRIX_EDGE_ROOT is not readable: ${rootAbs}`); }
  if (!rootStat.isDirectory()) throw new Error(`BRIX_EDGE_ROOT is not a directory: ${rootAbs}`);

  const mapPath = env.BRIX_EDGE_MAP ? resolve(env.BRIX_EDGE_MAP) : null;
  const map = mapPath ? readStationMap(mapPath) : null;

  const canary = new Set((env.BRIX_EDGE_CANARY_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const maxBytes = Number(env.BRIX_EDGE_MAX_BYTES ?? 32 * 1024 * 1024);
  const port = Number(env.BRIX_EDGE_PORT ?? 8787);
  const maxConnections = Number(env.BRIX_EDGE_MAX_CONNECTIONS ?? 512);
  return {
    root: rootAbs,
    map,
    mapPath,
    canary,
    hostnames: parseHostnames(env.BRIX_EDGE_HOSTNAMES),
    releasedName: env.BRIX_EDGE_RELEASED_NAME || "released.pdf",
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 32 * 1024 * 1024,
    maxConnections: Number.isInteger(maxConnections) && maxConnections > 0 ? maxConnections : 512,
    bind: env.BRIX_EDGE_BIND || "0.0.0.0",
    port: Number.isFinite(port) && port > 0 ? port : 8787
  };
}
