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

// CLOSED ALLOWLIST. A denylist misses spellings (`from "net"` without the
// node: prefix, `import "net"`, require). So every module specifier in src/,
// in any form, must be on this list or the test fails. Adding a module means
// editing this list, in public, in the same diff.
const ALLOWED_MODULES = new Set([
  "node:crypto", "node:fs", "node:http", "node:path",
  "./config.mjs", "./metrics.mjs", "./resolve.mjs", "./server.mjs"
]);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;
const LOADERS = [
  /\brequire\s*\(/, /\bcreateRequire\b/, /\bprocess\s*\.\s*binding\b/,
  /\bprocess\s*\.\s*dlopen\b/, /\bprocess\s*\[/, /\bglobalThis\s*\[/,
  /\bWorker\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bmodule\.constructor\b/
];

test("every module src/ loads is on a closed allowlist, in any import form", () => {
  const offenders = [];
  for (const f of readdirSync(src)) {
    const text = readFileSync(join(src, f), "utf8");
    for (const m of text.matchAll(SPECIFIER)) if (!ALLOWED_MODULES.has(m[1])) offenders.push(`${f}: imports ${m[1]}`);
    for (const re of LOADERS) if (re.test(text)) offenders.push(`${f}: ${re}`);
  }
  assert.deepEqual(offenders, []);
});

test("the allowlist check catches the spellings a denylist misses", () => {
  const bad = [
    'import net from "net";', "import 'node:net';", 'import { connect } from "tls"',
    'const n = require("net")', 'process.binding("tcp_wrap")', 'globalThis["fe"+"tch"]("x")'
  ];
  for (const line of bad) {
    const caught = [...line.matchAll(SPECIFIER)].some((m) => !ALLOWED_MODULES.has(m[1])) || LOADERS.some((re) => re.test(line));
    assert.ok(caught, `not caught: ${line}`);
  }
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
