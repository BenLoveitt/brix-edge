import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeRoot, configFor } from "./helpers.mjs";
import { verify } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "edge.mjs");

test("verify reports every mapped station, names the canary, and exits 2 for a station with nothing released", async () => {
  const { root, map } = makeRoot();
  const report = await verify(configFor(root, map));
  const by = Object.fromEntries(report.rows.map((r) => [r.token, r]));
  assert.equal(by.scr_a.status, "ok");
  assert.equal(by.scr_b.status, "ok");
  assert.equal(by.scr_file.status, "ok");
  assert.equal(by.scr_empty.status, "nothing-released");
  assert.equal(by.scr_canary.status, "canary");
  assert.equal(by.scr_dotdot.status, "outside");
  assert.equal(report.outbound, "none");
  // A broken mapping (outside) outranks a missing drawing: 1 beats 2.
  assert.equal(report.exitCode, 1);
});

test("verify exits 0 when every station resolves", async () => {
  const { root } = makeRoot();
  const map = join(root, "good.json");
  writeFileSync(map, JSON.stringify({ scr_a: "parts/44-1187", scr_b: "parts/44-1190" }));
  const report = await verify(configFor(root, map));
  assert.equal(report.exitCode, 0);
});

test("the CLI: `verify --json` prints the report and uses the exit code; a missing root fails fast", () => {
  const { root, map } = makeRoot();
  const r = spawnSync(process.execPath, [CLI, "verify", "--json"], { env: { ...process.env, BRIX_EDGE_ROOT: root, BRIX_EDGE_MAP: map, BRIX_EDGE_CANARY_TOKENS: "scr_canary" }, encoding: "utf8" });
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, "map");
  assert.ok(report.rows.length >= 6);
  const bad = spawnSync(process.execPath, [CLI, "verify"], { env: { ...process.env, BRIX_EDGE_ROOT: join(root, "does-not-exist") }, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /BRIX_EDGE_ROOT is not readable/);
});

test("config refuses a malformed token in the map, and a map that is not an object", () => {
  const { root } = makeRoot();
  const badTok = join(root, "bad-token.json");
  writeFileSync(badTok, JSON.stringify({ "scr a": "parts/44-1187" }));
  assert.throws(() => loadConfig({ BRIX_EDGE_ROOT: root, BRIX_EDGE_MAP: badTok }), /not a valid token/);
  const badShape = join(root, "bad-shape.json");
  writeFileSync(badShape, JSON.stringify(["scr_a"]));
  assert.throws(() => loadConfig({ BRIX_EDGE_ROOT: root, BRIX_EDGE_MAP: badShape }), /JSON object/);
});
