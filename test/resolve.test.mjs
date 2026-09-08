import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { resolveToken } from "../src/resolve.mjs";
import { makeRoot, configFor } from "./helpers.mjs";

test("released.pdf wins over any other file in the station's folder", async () => {
  const { root, map } = makeRoot();
  const r = await resolveToken(configFor(root, map), "scr_a");
  assert.equal(r.kind, "file");
  assert.equal(basename(r.path), "released.pdf");
});

test("without a released.pdf the NEWEST pdf by modification time is served", async () => {
  const { root, map } = makeRoot();
  const r = await resolveToken(configFor(root, map), "scr_b");
  assert.equal(r.kind, "file");
  assert.equal(basename(r.path), "rev-b.pdf");
});

test("a mapped FILE is served directly", async () => {
  const { root, map } = makeRoot();
  const r = await resolveToken(configFor(root, map), "scr_file");
  assert.equal(r.kind, "file");
  assert.equal(basename(r.path), "44-1300.pdf");
});

test("a station folder with no pdf is 'nothing-released', not an error", async () => {
  const { root, map } = makeRoot();
  assert.equal((await resolveToken(configFor(root, map), "scr_empty")).kind, "nothing-released");
});

test("a token that is not in the map is unknown; a malformed token is unknown", async () => {
  const { root, map } = makeRoot();
  const cfg = configFor(root, map);
  assert.equal((await resolveToken(cfg, "scr_nope")).kind, "unknown");
  assert.equal((await resolveToken(cfg, "../etc")).kind, "unknown");
  assert.equal((await resolveToken(cfg, "")).kind, "unknown");
});

test("a mapped path that climbs out of the root is refused, and so is a symlink that escapes", async () => {
  const { root, map } = makeRoot();
  const cfg = configFor(root, map);
  assert.equal((await resolveToken(cfg, "scr_dotdot")).kind, "outside");
  const esc = await resolveToken(cfg, "scr_escape");
  assert.ok(esc.kind === "outside" || esc.kind === "nothing-released", `symlink escape must never serve (got ${esc.kind})`);
  assert.notEqual(esc.kind, "file");
});

test("identity mode: the token IS the folder under root; the map is not consulted", async () => {
  const { root } = makeRoot();
  const cfg = configFor(root, null);
  const r = await resolveToken(cfg, "canary");
  assert.equal(r.kind, "file");
  assert.equal(basename(r.path), "canary.pdf");
  // A token is ONE folder name: it cannot reach into a subfolder.
  assert.equal((await resolveToken(cfg, "parts/44-1187")).kind, "unknown");
  assert.equal((await resolveToken(cfg, "..")).kind, "unknown");
});

test("a drawing over the size cap is refused as too-large, with the size", async () => {
  const { root, map } = makeRoot();
  const cfg = configFor(root, map, { BRIX_EDGE_MAX_BYTES: "100" });
  const r = await resolveToken(cfg, "scr_a");
  assert.equal(r.kind, "too-large");
  assert.ok(r.size > 100);
});
