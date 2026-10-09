/**
 * Token → the one document a screen may fetch. This is the whole of the
 * "no file names in Brix" design: Brix stores a screen id; the folder that
 * holds that station's current drawing lives in YOUR map, on YOUR server.
 *
 * Rules, in order:
 *   1. The token must be well-formed and, in map mode, mapped. Anything else
 *      is `unknown` — and counted, because an unknown token is either a typo
 *      or a probe, and both are worth a look.
 *   2. The mapped path must stay inside the root. `..`, absolute paths and
 *      symlinks that escape are refused as `outside` — never served, never
 *      revealed.
 *   3. If the target is a PDF file (map mode only), that is the document. If it is a folder,
 *      RELEASED_NAME wins when present (the "replace the exact file"
 *      workflow), otherwise the newest `*.pdf` by modification time.
 *   4. A folder with no PDF is `nothing-released` — a real state on a shop
 *      floor (the drawing was pulled), reported as such rather than as an
 *      error, so the screen shows a card and the log says why.
 */
import { promises as fs, realpathSync } from "node:fs";
import { join, resolve, sep, extname, basename } from "node:path";
import { TOKEN_SHAPE } from "./config.mjs";

/** Is `candidate` inside `root` once symlinks are resolved? */
async function insideRoot(root, candidate) {
  let real;
  try { real = await fs.realpath(candidate); }
  catch { return false; }
  const rootReal = realpathSync(root);
  return real === rootReal || real.startsWith(rootReal + sep);
}

/**
 * @returns {Promise<
 *   | { kind: "file"; path: string; size: number; mtimeMs: number; name: string }
 *   | { kind: "unknown" } | { kind: "outside" } | { kind: "nothing-released" } | { kind: "too-large"; size: number }
 * >}
 */
export async function resolveToken(cfg, token) {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return { kind: "unknown" };
  let rel;
  if (cfg.map) {
    rel = cfg.map.get(token);
    if (rel === undefined) return { kind: "unknown" };
  } else {
    rel = token; // identity mode: the token is a folder directly under root
  }
  if (rel.includes("\0") || resolve(rel) === rel /* absolute */) return { kind: "outside" };
  const target = resolve(cfg.root, rel);
  if (!(target === cfg.root || target.startsWith(cfg.root + sep))) return { kind: "outside" };
  if (!(await insideRoot(cfg.root, target))) {
    // Either it escapes through a symlink, or it does not exist yet.
    let exists = true;
    try { await fs.lstat(target); } catch { exists = false; }
    return exists ? { kind: "outside" } : { kind: "nothing-released" };
  }
  // Identity mode: the token must be the folder's name EXACTLY. A
  // case-insensitive filesystem (APFS, NTFS) would otherwise open `canary/`
  // for `CANARY` or `canary.` — a name no screen was given, which the
  // server's exact-match canary check never sees.
  if (!cfg.map) {
    let names;
    try { names = await fs.readdir(cfg.root); } catch { return { kind: "nothing-released" }; }
    if (!names.includes(token)) return { kind: "unknown" };
  }

  const st = await fs.stat(target);
  let file;
  if (st.isFile()) {
    // Identity mode names station FOLDERS only: a token that happens to be the
    // name of a loose file at the top of the share (notes, the map itself) is
    // unknown, not served. And whatever the mode, only a PDF is a drawing —
    // the response is labelled application/pdf and nothing else is promised.
    if (!cfg.map || extname(target).toLowerCase() !== ".pdf") return { kind: "unknown" };
    file = target;
  } else if (st.isDirectory()) {
    file = await pickInFolder(target, cfg.releasedName);
    if (!file) return { kind: "nothing-released" };
    if (!(await insideRoot(cfg.root, file))) return { kind: "outside" };
  } else {
    return { kind: "nothing-released" };
  }
  const fst = await fs.stat(file);
  if (fst.size > cfg.maxBytes) return { kind: "too-large", size: fst.size };
  return { kind: "file", path: file, size: fst.size, mtimeMs: fst.mtimeMs, name: basename(file) };
}

/** RELEASED_NAME if present, else the newest *.pdf by mtime, else null. */
async function pickInFolder(dir, releasedName) {
  const released = join(dir, releasedName);
  try { if ((await fs.stat(released)).isFile()) return released; } catch { /* not there */ }
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries) {
    if (!e.isFile() || extname(e.name).toLowerCase() !== ".pdf") continue;
    const p = join(dir, e.name);
    const st = await fs.stat(p);
    if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
  }
  return best ? best.p : null;
}
