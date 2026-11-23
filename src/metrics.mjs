/**
 * Counters, exposed as Prometheus text on /metrics so YOUR monitoring can
 * alert on the things that matter here:
 *
 *   brix_edge_canary_requests_total   > 0  — something asked for a token no screen was given
 *   brix_edge_unknown_token_total     rising — a typo in the map, or a probe
 *   brix_edge_no_released_total       rising — a station whose folder holds no drawing
 *   brix_edge_last_served_timestamp_seconds{station} — a station that stopped asking is a station that stopped checking
 *
 * Per-station series carry a STATION LABEL, not the token: the first 12 hex
 * characters of sha256(token). /metrics answers anyone who may reach the port,
 * and a list of every valid token is exactly what a prober needs. `verify`
 * prints each token's label, so you can still tell the stations apart.
 *
 * Nothing here leaves this process. There is no push, no remote write, no
 * agent — you scrape it, or you do not.
 */
import { createHash } from "node:crypto";

/** The label a token's series carry on /metrics. */
export const stationLabel = (token) => createHash("sha256").update(String(token)).digest("hex").slice(0, 12);

export class Metrics {
  constructor() {
    this.requests = new Map();      // `${route}|${status}` → n
    this.served = new Map();        // station label → n
    this.lastServed = new Map();    // station label → unix seconds
    this.notModified = 0;
    this.unknownToken = 0;
    this.canary = 0;
    this.noReleased = 0;
    this.outside = 0;
    this.tooLarge = 0;
    this.refusedHost = 0;
    this.hashReads = 0;
    this.mapReloads = 0;
    this.mapReloadErrors = 0;
    this.bytesSent = 0;
    this.startedAt = Date.now();
  }

  request(route, status) {
    const k = `${route}|${status}`;
    this.requests.set(k, (this.requests.get(k) ?? 0) + 1);
  }

  servedDrawing(token, bytes) {
    const label = stationLabel(token);
    this.served.set(label, (this.served.get(label) ?? 0) + 1);
    this.lastServed.set(label, Math.floor(Date.now() / 1000));
    this.bytesSent += bytes;
  }

  /** Prometheus text exposition format 0.0.4. */
  render(extra = {}) {
    const lines = [];
    const gauge = (name, help, value, labels = "") => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`);
    };
    const counterHeader = (name, help) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);

    gauge("brix_edge_up", "1 while the process is serving.", 1);
    gauge("brix_edge_info", "The running version.", 1, `{version="${esc(extra.version ?? "")}",mode="${esc(extra.mode ?? "")}"}`);
    gauge("brix_edge_start_time_seconds", "When this process started (unix seconds).", Math.floor(this.startedAt / 1000));
    gauge("brix_edge_tokens_mapped", "Tokens in the station map (0 in identity mode).", extra.tokensMapped ?? 0);

    counterHeader("brix_edge_requests_total", "HTTP requests by route and status.");
    for (const [k, n] of [...this.requests.entries()].sort()) {
      const [route, status] = k.split("|");
      lines.push(`brix_edge_requests_total{route="${route}",status="${status}"} ${n}`);
    }
    counterHeader("brix_edge_drawings_served_total", "Full drawing bodies served, by station label (sha256 of the token, 12 hex; `verify` lists them).");
    for (const [t, n] of [...this.served.entries()].sort()) lines.push(`brix_edge_drawings_served_total{station="${esc(t)}"} ${n}`);
    gaugeMany(lines, "brix_edge_last_served_timestamp_seconds", "When each station last received a full drawing (unix seconds).", this.lastServed);
    counterHeader("brix_edge_not_modified_total", "Conditional requests answered 304 — the screen already had the current drawing.");
    lines.push(`brix_edge_not_modified_total ${this.notModified}`);
    counterHeader("brix_edge_unknown_token_total", "Requests for a token that is not in the map.");
    lines.push(`brix_edge_unknown_token_total ${this.unknownToken}`);
    counterHeader("brix_edge_canary_requests_total", "Requests for a CANARY token — no screen was ever given one. Alert on any value above 0.");
    lines.push(`brix_edge_canary_requests_total ${this.canary}`);
    counterHeader("brix_edge_no_released_total", "Requests for a mapped station whose folder holds no drawing.");
    lines.push(`brix_edge_no_released_total ${this.noReleased}`);
    counterHeader("brix_edge_refused_outside_root_total", "Mapped paths that escape the root (misconfiguration, or a symlink pointing out). Never served.");
    lines.push(`brix_edge_refused_outside_root_total ${this.outside}`);
    counterHeader("brix_edge_refused_too_large_total", "Drawings over BRIX_EDGE_MAX_BYTES, refused with 413.");
    lines.push(`brix_edge_refused_too_large_total ${this.tooLarge}`);
    counterHeader("brix_edge_refused_host_total", "Requests refused with 421 because the Host header is not an IP address, a private name or a name in BRIX_EDGE_HOSTNAMES (DNS rebinding).");
    lines.push(`brix_edge_refused_host_total ${this.refusedHost}`);
    counterHeader("brix_edge_hash_reads_total", "Times a drawing was read to compute its ETag. One per new or changed file.");
    lines.push(`brix_edge_hash_reads_total ${this.hashReads}`);
    counterHeader("brix_edge_map_reloads_total", "Times the station map was re-read after it changed.");
    lines.push(`brix_edge_map_reloads_total ${this.mapReloads}`);
    counterHeader("brix_edge_map_reload_errors_total", "Times a changed station map was refused (the previous map stays in use). Alert on any rise.");
    lines.push(`brix_edge_map_reload_errors_total ${this.mapReloadErrors}`);
    counterHeader("brix_edge_bytes_sent_total", "Drawing bytes served.");
    lines.push(`brix_edge_bytes_sent_total ${this.bytesSent}`);
    return lines.join("\n") + "\n";
  }
}

function gaugeMany(lines, name, help, map) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const [t, v] of [...map.entries()].sort()) lines.push(`${name}{station="${esc(t)}"} ${v}`);
}

function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n"); }
