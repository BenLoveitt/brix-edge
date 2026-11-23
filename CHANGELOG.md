# Changelog

## 0.2.0 (2026-11-23)

A security review as an attacker on the customer network. SECURITY.md lists each claim with its test.

### Changes you must act on

- **The server checks the `Host` header.** It refuses a request with `421` if the `Host` is not an IP address, `localhost`, or a name that ends `.local`, `.internal` or `.home.arpa`. If your screens use another name, for example `edge.corp.example.com`, add it to `BRIX_EDGE_HOSTNAMES` before you upgrade. This stops DNS rebinding: a web page that points its own name at this server can no longer read it through a browser.
- **`/metrics` shows no tokens.** Per-station series have a `station` label (12 hex characters of the SHA-256 of the token) in place of the `token` label. `verify` shows the label of each token. Change your alert rules and dashboards that use `token=`.
- **The image is distroless.** It starts from `gcr.io/distroless/nodejs22-debian12:nonroot`, pinned by digest. It has no shell. Use `docker run --rm … brix-edge:0.2.0 verify` in place of `docker exec brix-edge node src/edge.mjs verify`.

### Fixed

- A client that sent its headers slowly could hold a connection for 60 s or more, and there was no limit on connections. Now the head must arrive in 10 s, the request in 30 s, and an idle connection closes after 60 s. At most 512 connections (`BRIX_EDGE_MAX_CONNECTIONS`).
- The server checked a file's path, then opened it by path again. A person with write access to the share could swap the file for a symlink out of the root, or for a FIFO, between the two steps. Now the server opens the file once and checks that the open file is the one it resolved.
- The server hashed the file and then sent it in two separate reads. A file that changed between them could get the wrong `ETag`, or a body longer than `Content-Length`. Now both come from one file descriptor, and the body is exactly the measured size.
- A drawing copied in with an older modification time (robocopy, `rsync -t`) got `304` from a client that sends only `If-Modified-Since`. `Last-Modified` is now the later of the modification time and the change time.
- Many screens that asked at the same moment after a change each read the whole file to hash it. Now they share one read.
- IIS serves every `.pdf` in a station's folder by name, not only `released.pdf`. The installer now warns, and `Test-BrixEdge.ps1` fails with status `exposed`, when a station's folder has another PDF. The README says so.
- On Windows, the Node server refused every station as "outside the root" when the root path had a short (8.3) name or a different letter case than the folder. It now compares the same kind of real path on both sides.
- Windows PowerShell 5.1 could not parse the IIS scripts: they had no byte-order mark, so it read the em dashes in them as quote marks. The scripts are now saved as UTF-8 with a byte-order mark. CI runs the IIS tests on Windows PowerShell 5.1.
- The `web.config` comment said `maxAllowedContentLength` limits the drawing size. It limits the request body only. The comment is now correct.

### Added

- The server reads the station map again within 2 s of a change. It keeps the previous map if the new one is not valid, and logs and counts that.
- New metrics: `brix_edge_info{version,mode}`, `brix_edge_refused_host_total`, `brix_edge_hash_reads_total`, `brix_edge_map_reloads_total`, `brix_edge_map_reload_errors_total`.
- Drawing responses send `Accept-Ranges: none`.
- `SECURITY.md`: each claim, its test and the command to check it.
- `scripts/egress-proof.sh`: runs the image with no network and shows that it still serves.
- `scripts/reproduce.sh`: a reproducible image build that prints the digest.
- CI in public (`.github/workflows/ci.yml`): tests on Node 20, 22 and 24 on Linux, and Node 22 on Windows and macOS; the IIS kit tests on PowerShell 7 and Windows PowerShell 5.1; the egress proof; two clean image builds with the same digest.
- Release workflow: source archive, CycloneDX SBOM, `SHA256SUMS`, the image digest, and a signed build-provenance attestation for each.
- OpenSSF Scorecard and Dependabot (base-image digest and Actions).
- `package-lock.json`, with no dependencies in it.

## 0.1.0 (2026-09-08)

The first release.
