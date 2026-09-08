import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createEdgeServer } from "../src/server.mjs";

/** A minimal, valid, one-page PDF with `label` as its text. */
export function pdfBytes(label = "SHEET 1") {
  const stream = `BT /F1 24 Tf 60 720 Td (${label}) Tj ET\n`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((b, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * A drawings root shaped like a customer's:
 *   parts/44-1187/released.pdf + parts/44-1187/older.pdf  (released wins)
 *   parts/44-1190/rev-a.pdf, rev-b.pdf                    (newest wins)
 *   parts/44-1200/                                        (nothing released)
 *   parts/44-1300.pdf                                     (a file target)
 *   canary/canary.pdf
 *   escape -> symlink to a folder OUTSIDE the root
 */
export function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "brix-edge-root-"));
  const outside = mkdtempSync(join(tmpdir(), "brix-edge-outside-"));
  mkdirSync(join(root, "parts", "44-1187"), { recursive: true });
  writeFileSync(join(root, "parts", "44-1187", "older.pdf"), pdfBytes("OLDER"));
  writeFileSync(join(root, "parts", "44-1187", "released.pdf"), pdfBytes("RELEASED"));
  mkdirSync(join(root, "parts", "44-1190"), { recursive: true });
  writeFileSync(join(root, "parts", "44-1190", "rev-a.pdf"), pdfBytes("REV A"));
  writeFileSync(join(root, "parts", "44-1190", "rev-b.pdf"), pdfBytes("REV B"));
  utimesSync(join(root, "parts", "44-1190", "rev-a.pdf"), new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(join(root, "parts", "44-1190", "rev-b.pdf"), new Date(2026, 5, 1), new Date(2026, 5, 1));
  mkdirSync(join(root, "parts", "44-1200"), { recursive: true });
  writeFileSync(join(root, "parts", "44-1300.pdf"), pdfBytes("FILE TARGET"));
  mkdirSync(join(root, "canary"), { recursive: true });
  writeFileSync(join(root, "canary", "canary.pdf"), pdfBytes("CANARY"));
  writeFileSync(join(outside, "secret.pdf"), pdfBytes("OUTSIDE"));
  try { symlinkSync(outside, join(root, "escape")); } catch { /* no symlinks here */ }
  const map = join(root, "stations.json");
  writeFileSync(map, JSON.stringify({
    _comment: "test map",
    scr_a: "parts/44-1187",
    scr_b: "parts/44-1190",
    scr_empty: "parts/44-1200",
    scr_file: "parts/44-1300.pdf",
    scr_escape: "escape",
    scr_dotdot: "../outside-of-root",
    scr_canary: "canary"
  }));
  return { root, outside, map };
}

export function configFor(root, map, extra = {}) {
  return loadConfig({ BRIX_EDGE_ROOT: root, ...(map ? { BRIX_EDGE_MAP: map } : {}), BRIX_EDGE_CANARY_TOKENS: "scr_canary", ...extra });
}

/** Boot a server on an ephemeral loopback port; returns base url + close(). */
export async function boot(cfg) {
  const logs = [];
  const server = createEdgeServer(cfg, { log: (e) => logs.push(e) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, logs, metrics: server.metrics, close: () => new Promise((r) => server.close(r)) };
}
