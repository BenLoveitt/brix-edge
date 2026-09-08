#!/usr/bin/env node
/**
 * brix-edge — the on-premises drawing server for Brix sealed screens.
 *
 *   brix-edge start     serve (the container's default)
 *   brix-edge verify    prove the configuration: every station resolves to a
 *                       document, canaries are declared, nothing escapes the
 *                       root. Exit 0 ok · 1 broken config · 2 a station with
 *                       nothing released. `--json` for machines.
 *
 * This program opens no outbound connection. See README.md for how to check
 * that yourself rather than believe it.
 */
import { loadConfig } from "./config.mjs";
import { createEdgeServer, verify } from "./server.mjs";

const cmd = process.argv[2] ?? "start";
const wantJson = process.argv.includes("--json");

function fail(msg, code = 1) { process.stderr.write(`brix-edge: ${msg}\n`); process.exit(code); }

if (cmd === "verify") {
  let cfg;
  try { cfg = loadConfig(); } catch (e) { fail(e.message); }
  const report = await verify(cfg);
  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`brix-edge verify\n  root:      ${report.root}\n  mode:      ${report.mode}\n  released:  ${report.releasedName} wins; else newest *.pdf\n  max bytes: ${report.maxBytes}\n  outbound:  ${report.outbound}\n\n`);
    if (report.rows.length === 0) process.stdout.write("  (identity mode: any folder under root is a station; nothing to enumerate)\n");
    for (const r of report.rows) {
      const detail = r.status === "ok" ? `${r.bytes} bytes, modified ${r.modified}` : (r.note ?? "");
      process.stdout.write(`  ${r.status.padEnd(17)} ${r.token}  ${detail}\n`);
    }
    process.stdout.write(`\n${report.exitCode === 0 ? "OK" : report.exitCode === 2 ? "WARN: a station has nothing released" : "FAIL: a mapped path is broken"}\n`);
  }
  process.exit(report.exitCode);
}

if (cmd !== "start") fail(`unknown command ${cmd}; use start or verify`);

let cfg;
try { cfg = loadConfig(); } catch (e) { fail(e.message); }
const server = createEdgeServer(cfg);
server.listen(cfg.port, cfg.bind, () => {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(), event: "listening", bind: cfg.bind, port: cfg.port, root: cfg.root,
    mode: cfg.map ? "map" : "identity", tokensMapped: cfg.map ? cfg.map.size : 0, canaries: cfg.canary.size, outbound: "none"
  }) + "\n");
});
const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
