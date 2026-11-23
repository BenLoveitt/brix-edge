# Security

This file lists each security claim that brix-edge makes. For each claim it names the test that enforces it and the command that you run to check it. You do not need an account, a key or a call to us. CI runs every check below in public on each push: [ci workflow](https://github.com/BenLoveitt/brix-edge/actions/workflows/ci.yml).

## Report a problem

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and select **Report a vulnerability**. Do not open a public issue for a security problem.

## Run all checks

```bash
node --test                                   # every test in test/
pwsh -File windows/Test-BrixEdge.Common.ps1   # the IIS kit's logic (PowerShell 7 or Windows PowerShell 5.1)
scripts/egress-proof.sh                       # needs Docker
scripts/reproduce.sh                          # needs Docker with buildx
```

## Claims, and how to check them

### The server opens no outbound connection

| Check | What it shows |
|---|---|
| `test/no-egress.test.mjs` | Every module `src/` loads, in any import form, is on a closed allowlist (`node:crypto`, `node:fs`, `node:http`, `node:path` and the four source files). `require`, `process.binding`, `eval`, workers and computed global lookups fail the test. To add a module, a change must edit the allowlist in the same diff. Also, `src/` contains no outbound network primitive: no `fetch`, no HTTP client, no `node:net`, `node:tls`, `node:dns`, `node:dgram`, `node:child_process` and no dynamic `import()`. The only network module is `node:http`, and only `createServer` from it. |
| `scripts/egress-proof.sh` (CI job `image`) | The image runs with `--network none`, `--read-only`, `--cap-drop ALL` and `no-new-privileges`. The only interface is loopback. The server still serves a drawing. A request from inside the container to an outside address fails. No socket has a remote address other than loopback. |

### The server serves only the one drawing of a known station

| Check | What it shows |
|---|---|
| `test/resolve.test.mjs`: "a mapped path that climbs out of the root is refused, and so is a symlink that escapes" | `..`, absolute paths and symlinks that lead out of the root are refused. |
| `test/security.test.mjs`: "check-then-open race: a drawing swapped for a symlink out of the root after the check is not opened" | The server opens the file, then resolves its path again and compares device and inode. A swap between the check and the open is refused. |
| `test/security.test.mjs`: "check-then-open race: a drawing swapped for a FIFO is not opened, and nothing hangs" | Only a regular file is opened. A FIFO cannot hold a request open. |
| `test/resolve.test.mjs`: "identity mode serves only a station FOLDER", "a mapped file that is not a PDF is never served" | A loose file at the top of the root is not served. Only a `.pdf` is a drawing. |
| `test/resolve.test.mjs`: "identity mode matches the folder name EXACTLY" and `test/server.test.mjs`: "a case or trailing-dot variant of a canary token is refused and counted as the canary" | On a case-insensitive file system (NTFS, APFS), `CANARY` and `canary.` do not open the `canary` folder. They count as canary requests. A token has letters, digits, `.`, `_` and `-` only, so `::$DATA`, `~1` short names, spaces, `/` and `\` cannot be part of one. |
| `test/server.test.mjs`: "only GET and HEAD exist; nothing else is a route" | Other methods get `405`. A folder is never listed. A direct path is never served. |

### A response tells a prober nothing it does not already know

| Check | What it shows |
|---|---|
| `test/server.test.mjs`: "serves the drawing as application/pdf with validators, and no file name anywhere in the response" and `test/security.test.mjs`: "a drawing response says it takes no ranges, and never names the file" | No header names the file or the folder. Error responses have no body. |
| `test/security.test.mjs`: "/metrics and /healthz carry no token" | `/metrics` labels each station with the first 12 hex characters of the SHA-256 of its token, not with the token. |
| `test/server.test.mjs`: "an unknown token is 404 and COUNTED; a canary token is 404 and counted SEPARATELY" | A canary request reads no file and is counted and logged with the client address. |

### A web page cannot read the server through a browser (DNS rebinding)

| Check | What it shows |
|---|---|
| `test/security.test.mjs`: "DNS rebinding: a request whose Host names some other site is refused with 421 and counted" | A `Host` header that is not an IP address, `localhost`, a `.local`, `.internal` or `.home.arpa` name, or a name in `BRIX_EDGE_HOSTNAMES` gets `421`. This applies to every route, `/metrics` included. |

### One client cannot stop the service for the others

| Check | What it shows |
|---|---|
| `test/security.test.mjs`: "slowloris: the default limits are short, and a client that never finishes its headers is cut off" | The request head must arrive in 10 s and the request in 30 s. A connection with no progress for 60 s is closed. At most 512 connections (`BRIX_EDGE_MAX_CONNECTIONS`) and 64 headers of 8 KiB in total. |
| `test/server.test.mjs`: "a malformed percent-escape is a counted 404, and the server keeps serving" and "an internal error in a request is a 500, not a dead server" | A bad request ends that request only. |
| `test/security.test.mjs`: "two hundred screens asking at once after a change cost one read of the file" | The server reads a changed drawing once to hash it, however many screens ask at the same time. |
| `test/server.test.mjs`: "an oversize drawing is refused with 413" | A drawing over `BRIX_EDGE_MAX_BYTES` (32 MiB) is not sent. |

### A screen gets the correct drawing

| Check | What it shows |
|---|---|
| `test/security.test.mjs`: "the body is exactly the bytes the ETag describes" | The server hashes and sends from one open file descriptor, and sends exactly the size it measured. |
| `test/server.test.mjs`: "the minute check: If-None-Match …" | An unchanged drawing gets `304`. A changed one gets `200` and a new `ETag`. |
| `test/security.test.mjs`: "If-Modified-Since: a newer drawing copied in with an OLDER modification time is still sent" | `Last-Modified` is the later of the modification time and the change time. |
| `test/security.test.mjs`: "the station map is re-read when it changes; a broken map is refused and the old one stays" | A bad edit to the map does not take stations off the air. |

### The image holds only what you read

| Check | What it shows |
|---|---|
| `test/image.test.mjs` | The `Dockerfile` has one `FROM`, pinned by digest. It has no `RUN` and no `ADD`, and it copies only `package.json` and `src/`. It runs as a numeric non-root user (65532). `ENTRYPOINT`, `CMD` and `HEALTHCHECK` are exec form, so the image needs no shell. The build context is an allowlist. |
| `test/image.test.mjs`: "package.json has no dependencies of any kind, and the lockfile agrees" | Zero dependencies, also checked by the `No dependencies` step in CI. |
| `scripts/reproduce.sh` (CI job `image` builds twice and compares) | Two clean builds of one commit give the same image digest (linux/amd64, BuildKit, timestamps set to the commit time). CI checks this on GitHub's Ubuntu runner on each push. We have not compared builds across different machines yet. If your digest differs from a release's, open an issue with your Docker and BuildKit versions. |

### A release is what CI built from the tag

The release workflow (`.github/workflows/release.yml`) runs on a tag `v<version>`. It runs the tests and the egress proof, then it publishes these files on the GitHub release:

- `brix-edge-<version>.tar.gz`: the source at the tag (`git archive`, `gzip -n`)
- `brix-edge-<version>.cdx.json`: a CycloneDX SBOM. It lists brix-edge and no other component.
- `SHA256SUMS`: the checksums of the two files above
- `image-digest.txt`: the digest that `scripts/reproduce.sh` gave at the tag

Each file and the image digest has a signed GitHub artifact attestation (SLSA build provenance, signed through Sigstore with no stored key). Check a file:

```bash
gh attestation verify brix-edge-0.2.0.tar.gz --repo BenLoveitt/brix-edge
sha256sum -c SHA256SUMS
```

Check your own image build against the release: run `scripts/reproduce.sh` at the tag and compare the output with `image-digest.txt`.

### The IIS kit

| Check | What it shows |
|---|---|
| `windows/Test-BrixEdge.Common.ps1` (CI: `pwsh` on Linux and Windows, and Windows PowerShell 5.1) | Token shape, the root-containment rule, CIDR to subnet mask, `stations.json` reading, W3C log parsing and canary classification, the list of other PDFs that IIS would serve by name, and the HTTP probe against the Node server. |
| `windows/Test-BrixEdge.ps1` on your IIS host | What only the host can show: every station serves with an `ETag` and `304`, an unknown token is `404`, `/drawings/` is not a listing, `POST` is refused, `web.config` is not served, canaries are mapped, and no other PDF is reachable in a station's folder. |

The CI does not run IIS. The behavior that comes from `web.config` is checked only by `Test-BrixEdge.ps1` on your host.

## What brix-edge does not protect against

These are limits, not bugs. Plan for them.

- **Plain HTTP.** Screens fetch over HTTP on your network. Anyone who can see that traffic can see the token and the drawing. Keep the screens and the server on a network segment you control.
- **A token is not a password.** It is a screen id. Brix makes it from 74 random bits, so a prober cannot guess it. But it appears in your logs and in the Brix console. In identity mode the token is your folder name, which is often easy to guess.
- **Anyone who can reach the port can ask.** brix-edge does not check client addresses. Use a firewall rule, or `-AllowFrom` on IIS, so that only the screens' subnets can reach it.
- **Write access to the drawings folder is trusted.** A person who can write there can change what the screens show. The server refuses symlinks that lead out of the root. It cannot see a hard link to a file elsewhere on the same file system.
- **A half-copied file.** If a copy is still running when a screen asks, the screen can get a part of the file. Copy to a temporary name and rename it into place, or use `released.pdf` and replace it in one step. A `.tmp` or `.part` name is never served, because only `.pdf` names are.
- **IIS serves other PDFs by name.** See "Keep only the drawing in a station's folder on IIS" in the README.

## Review history

| Date | Scope | Result |
|---|---|---|
| 2026-10-08 | Identity mode, canary variants, error handling | Three fixes. See `git log` for 2026-10-08. |
| 2026-11-23 | Full review as an attacker on the customer network: paths, symlinks, case and Windows names, headers, ranges and conditional requests, slow clients, token enumeration, error text, the canary, `web.config`, the image | Seven fixes in 0.2.0. See CHANGELOG.md. |
