/**
 * Configuration — environment only, so what the container does is visible in
 * the `docker run` line and nowhere else.
 *
 *   BRIX_EDGE_ROOT            the folder holding the drawings (required)
 *   BRIX_EDGE_MAP             JSON file: { "<screen token>": "<folder or file under ROOT>" }
 *                             Absent = IDENTITY mode: the token IS a folder name under ROOT.
 *   BRIX_EDGE_CANARY_TOKENS   comma-separated tokens that no screen is ever given.
 *                             A request for one is an alarm, not a 404.
 *   BRIX_EDGE_RELEASED_NAME   the file that wins inside a folder when present (default released.pdf);
 *                             otherwise the newest *.pdf by modification time is served.
 *   BRIX_EDGE_MAX_BYTES       refuse a drawing larger than this (default 32 MiB — the screen's own cap)
 *   BRIX_EDGE_BIND / _PORT    where to listen (default 0.0.0.0:8787)
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** A token starts with a letter or digit, so "." and ".." can never be one —
 *  the root check would catch them anyway; this refuses them a step earlier. */
export const TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function loadConfig(env = process.env) {
  const root = env.BRIX_EDGE_ROOT;
  if (!root) throw new Error("BRIX_EDGE_ROOT is required: the folder that holds the drawings");
  const rootAbs = resolve(root);
  let rootStat;
  try { rootStat = statSync(rootAbs); } catch { throw new Error(`BRIX_EDGE_ROOT is not readable: ${rootAbs}`); }
  if (!rootStat.isDirectory()) throw new Error(`BRIX_EDGE_ROOT is not a directory: ${rootAbs}`);

  let map = null;
  if (env.BRIX_EDGE_MAP) {
    let raw;
    try { raw = JSON.parse(readFileSync(resolve(env.BRIX_EDGE_MAP), "utf8")); }
    catch (e) { throw new Error(`BRIX_EDGE_MAP is not readable JSON: ${env.BRIX_EDGE_MAP} (${e.message})`); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("BRIX_EDGE_MAP must be a JSON object of token → path");
    map = new Map();
    for (const [token, target] of Object.entries(raw)) {
      if (token.startsWith("_")) continue; // "_comment" and friends
      if (!TOKEN_SHAPE.test(token)) throw new Error(`BRIX_EDGE_MAP: token ${JSON.stringify(token)} is not a valid token (letters, digits, . _ - only)`);
      if (typeof target !== "string" || !target) throw new Error(`BRIX_EDGE_MAP: token ${token} must map to a path string`);
      map.set(token, target);
    }
  }

  const canary = new Set((env.BRIX_EDGE_CANARY_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const maxBytes = Number(env.BRIX_EDGE_MAX_BYTES ?? 32 * 1024 * 1024);
  const port = Number(env.BRIX_EDGE_PORT ?? 8787);
  return {
    root: rootAbs,
    map,
    canary,
    releasedName: env.BRIX_EDGE_RELEASED_NAME || "released.pdf",
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 32 * 1024 * 1024,
    bind: env.BRIX_EDGE_BIND || "0.0.0.0",
    port: Number.isFinite(port) && port > 0 ? port : 8787
  };
}
