/**
 * THE PROMISE, AS A GATE: this program opens no outbound connection.
 *
 * A reviewer can read the four source files in ten minutes. This test is so
 * that a future change cannot quietly add a fetch, a DNS lookup or a socket to
 * somewhere else: it scans src/ for every outbound primitive Node offers and
 * fails on any of them. Run it yourself: `node --test test/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const OUTBOUND = [
  /\bfetch\s*\(/,                       // global fetch
  /\bhttps?\.(request|get)\s*\(/,       // node:http(s) clients
  /from\s+["']node:https["']/,           // the https module at all
  /from\s+["']node:net["']/,             // raw sockets
  /from\s+["']node:tls["']/,
  /from\s+["']node:dns["']/,             // name lookups
  /from\s+["']node:dgram["']/,           // UDP
  /from\s+["']node:child_process["']/,   // shelling out
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bimport\s*\(/                        // dynamic import (a way to smuggle any of the above)
];

test("src/ contains no outbound network primitive", () => {
  const offenders = [];
  for (const f of readdirSync(src)) {
    const text = readFileSync(join(src, f), "utf8");
    for (const re of OUTBOUND) if (re.test(text)) offenders.push(`${f}: ${re}`);
  }
  assert.deepEqual(offenders, []);
});

test("the only network module imported is the inbound server (node:http createServer)", () => {
  const imports = new Set();
  for (const f of readdirSync(src)) {
    for (const m of readFileSync(join(src, f), "utf8").matchAll(/from\s+["'](node:[a-z_/]+)["']/g)) imports.add(m[1]);
  }
  const network = [...imports].filter((m) => ["node:http", "node:https", "node:net", "node:tls", "node:dns", "node:dgram", "node:http2"].includes(m));
  assert.deepEqual(network, ["node:http"]);
  const http = readFileSync(join(src, "server.mjs"), "utf8");
  assert.match(http, /import \{ createServer \} from "node:http"/);
});
