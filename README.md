# brix-edge

[![ci](https://github.com/BenLoveitt/brix-edge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/BenLoveitt/brix-edge/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/BenLoveitt/brix-edge/badge)](https://scorecard.dev/viewer/?uri=github.com/BenLoveitt/brix-edge)

The on-premises drawing server for Brix **sealed screens**. It runs on a server you own, inside your network, and does one thing: when a screen asks for the drawing that belongs to it, it serves the current released PDF from a folder you control.

It opens **no outbound connection**. It never talks to Brix. Block it from the internet entirely and nothing about it changes.

## Prove it before you run it

Nothing here needs an account, a licence key or a call to us.

```bash
node --test                                   # routing, containment, the 304, the canary, the attacks in SECURITY.md
pwsh -File windows/Test-BrixEdge.Common.ps1   # the IIS kit's logic, if you take the IIS route
scripts/egress-proof.sh                       # runs the image with no network at all and shows that it still serves
scripts/reproduce.sh                          # builds the image and prints its digest; compare it with a release
```

Then read `src/`. It is five files with no dependencies. Read `windows/web.config` too: it is the whole IIS configuration on one page.

**[SECURITY.md](SECURITY.md) lists each security claim, the test that enforces it and the command that checks it.** The same tests run in public on every push ([ci](https://github.com/BenLoveitt/brix-edge/actions/workflows/ci.yml)). For example, `test/no-egress.test.mjs` fails if any outbound network primitive appears in `src/`, and the CI image job runs `scripts/egress-proof.sh`.

## What it is for

A Brix screen on a sealed account stores no drawing, no thumbnail and no page render in Brix. The screen fetches the document itself, from your network, and renders it on the device. What Brix holds about a station is a **screen id** and an address template such as:

```
http://brix-edge.plant.example:8787/drawings/{{screen.id}}
```

The template expands on each screen to its own id. This server maps that id to a folder in your file tree and serves whatever is released there. **No file name, part number or drawing ever enters Brix.** Which station builds which part is written in a JSON file on your server, or driven by your own systems.

When you replace the file, every screen gets the new copy at its next check and shows when its copy was fetched. The screen checks once a minute. The server reads a changed file once, however many screens ask.

## Run it

```bash
docker build -t brix-edge:0.2.0 .
docker run -d --name brix-edge --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 8787:8787 \
  -v /srv/drawings:/data/drawings:ro \
  -v /srv/stations.json:/data/stations.json:ro \
  -e BRIX_EDGE_CANARY_TOKENS=scr_canary000000000000000 \
  brix-edge:0.2.0
```

The image starts from a base image pinned by digest (distroless Node.js 22). It has no shell and no package manager, and it runs as user 65532. The server needs no write access anywhere, so `--read-only` and `--cap-drop ALL` cost nothing.

Or without Docker: `BRIX_EDGE_ROOT=/srv/drawings BRIX_EDGE_MAP=/srv/stations.json node src/edge.mjs start`. You need Node 20 or later and nothing else.

Check the configuration before you trust it:

```bash
docker run --rm -v /srv/drawings:/data/drawings:ro -v /srv/stations.json:/data/stations.json:ro brix-edge:0.2.0 verify
```

`verify` lists every mapped station, what it resolves to and its metrics label. Exit 0 means every station has a drawing. Exit 2 means a station has nothing released. Exit 1 means a mapping is broken.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `BRIX_EDGE_ROOT` | The folder that holds the drawings. Mount it read-only. | required |
| `BRIX_EDGE_MAP` | JSON file: `{ "<screen id>": "<folder or file under ROOT>" }`. The server reads it again within 2 seconds of a change. If the changed file is not valid, the server keeps the previous map, logs `map_refused` and counts it. Without a map the server runs in **identity mode**: the token is a folder name directly under ROOT. | none |
| `BRIX_EDGE_CANARY_TOKENS` | Comma-separated tokens that no screen is ever given. A request for one is an alarm. | none |
| `BRIX_EDGE_RELEASED_NAME` | The file that wins inside a station folder when present. Otherwise the newest `*.pdf` is served. | `released.pdf` |
| `BRIX_EDGE_MAX_BYTES` | Refuse a drawing larger than this. The screen has the same cap. | 32 MiB |
| `BRIX_EDGE_HOSTNAMES` | More names that the screens use to reach this server, comma-separated. `.corp.example.com` (with a leading dot) accepts every name under it. See "The Host check". | none |
| `BRIX_EDGE_MAX_CONNECTIONS` | The most client connections at one time. | `512` |
| `BRIX_EDGE_BIND`, `BRIX_EDGE_PORT` | Where to listen. | `0.0.0.0`, `8787` |

See `stations.example.json`.

## How a station's drawing is chosen

1. The token must be in the map (or, in identity mode, must be exactly the name of a folder directly under ROOT, letter case included). Anything else, including a loose file at the top of ROOT, is `unknown` and counted.
2. The mapped path must stay inside ROOT. `..`, absolute paths and symlinks that lead out are refused and counted. They are never served.
3. If the path is a `.pdf` file (map mode only), that is the drawing. If it is a folder, `released.pdf` wins when present; otherwise the newest `*.pdf` by modification time.
4. A folder with no PDF is **nothing released**: a 404 with the header `x-brix-edge-reason: nothing-released`, counted. The screen shows a card instead of a drawing.

## What it sends

For `GET /drawings/<token>`:

- `Content-Type: application/pdf`, `Content-Length`
- `ETag: "sha256:<hash of the file>"` and `Last-Modified`
- `Cache-Control: no-store` and `Accept-Ranges: none`

The screen checks again every minute with `If-None-Match`. An unchanged drawing costs a `304` with no body. There is no file name in any response. Only `GET` and `HEAD` exist. The only other routes are `/healthz` and `/metrics`.

The server hashes and sends the file from one open file descriptor. So the `ETag` always describes the bytes that were sent. `Last-Modified` is the later of the file's modification time and its change time. A copy tool that keeps the old time (robocopy, `rsync -t`) still gives a new `Last-Modified`.

## The Host check

A web page on the internet can try to read this server through an employee's browser. The page points its own name at this server's address (DNS rebinding). The browser then sends this server the page's name in the `Host` header. The server refuses that request with `421` and counts it in `brix_edge_refused_host_total`.

The server accepts these `Host` values: an IP address, `localhost`, a name that ends `.local`, `.internal` or `.home.arpa`, and the names in `BRIX_EDGE_HOSTNAMES`. If your screens use a name such as `edge.corp.example.com`, add it to `BRIX_EDGE_HOSTNAMES`. If you do not, the screens get `421`.

## How you verify it, every day, without asking us

**Your access log is the record.** Every request is one JSON line on stdout: time, remote address, token, status, bytes, and the file that was served. Ship it to your SIEM. It is written by software you run, and we cannot edit it.

**Metrics** at `/metrics` (Prometheus text). Alert on:

| Metric | Alert when |
|---|---|
| `brix_edge_canary_requests_total` | above 0. Something asked for a token no screen was given. |
| `brix_edge_unknown_token_total` | rising. A typo in the map, or a probe. |
| `brix_edge_no_released_total` | rising. A station whose folder is empty. |
| `brix_edge_last_served_timestamp_seconds{station}` | older than you expect. A screen that stopped asking stopped checking. |
| `brix_edge_refused_host_total` | above 0. Something used a name you did not configure, or a web page tried DNS rebinding. |
| `brix_edge_map_reload_errors_total` | rising. Your last change to the station map was refused. The previous map is still in use. |
| `brix_edge_up` | absent. The container is down. |

`/metrics` does not show tokens. Anyone who can reach the port can read `/metrics`, and a list of valid tokens is what a prober needs. Each per-station series has a `station` label instead: the first 12 hex characters of the SHA-256 of the token. `verify` shows the label of each token.

**No outbound connections.** Three ways to satisfy yourself, none of which involve trusting this file:

1. Read `src/`. Five files. The only network module imported is `node:http`, and only `createServer` from it. `node --test` runs `test/no-egress.test.mjs`, which fails on any outbound primitive in `src/`.
2. Run `scripts/egress-proof.sh`. It starts the image with `--network none`, so the container has only a loopback interface. The script shows that the server still serves a drawing, that nothing outside is reachable, and that no socket has a remote address other than loopback.
3. Watch the connections of your own container: `docker exec brix-edge /nodejs/bin/node -e "console.log(require('fs').readFileSync('/proc/net/tcp','utf8'))"` shows only listening sockets and inbound connections from your screens.

**The canary.** Map a token that you never give to any screen (the example maps `scr_canary000000000000000` to a `canary/` folder). Put a distinctive PDF there. If `brix_edge_canary_requests_total` ever moves, or that file's name ever appears in a log line, something other than your screens is asking, and you have the address it came from.

**Build it yourself.** We do not publish an image, and you do not need one. Build from a tag you have read. The `Dockerfile` pins the base image by digest, and the build has no install step because there are no dependencies. What you read is what runs.

To compare your build with ours, run `scripts/reproduce.sh` at the tag. It prints the image digest. CI builds each commit twice from scratch and requires the same digest; a build on a different machine has not been compared yet. Each GitHub release states the digest that the release workflow got at that tag, with a signed attestation. The release also has the source archive, a CycloneDX SBOM (no dependencies), `SHA256SUMS` and an attestation for each file. Check one with `gh attestation verify <file> --repo BenLoveitt/brix-edge`. SECURITY.md has the details.

## Microsoft shop? Run it on IIS, with nothing of ours on your server

If you run Windows Server, you do not need the container or Node. IIS already does everything the screen needs, natively: the default document, `ETag` and `Last-Modified` with `304` on a conditional request, request filtering, IP restrictions, and W3C logs your SIEM already reads. The `windows/` folder holds the whole setup:

| File | What it does |
|---|---|
| `windows/web.config` | The site's entire configuration, in one reviewable file: only `released.pdf` is a default document, no directory listing, only `GET` and `HEAD`, only `.pdf`, static file handler only, `Cache-Control: no-store`, empty error bodies. |
| `windows/Install-BrixEdgeIIS.ps1` | Creates the site and one virtual directory per screen id from your `stations.json`, restricts it to the screens' subnets (IIS and Windows Firewall), turns on W3C logging with the fields that matter, and prints the address to save in Brix. Idempotent: rerun after you edit the JSON. |
| `windows/Test-BrixEdge.ps1` | Proves it: every station answers `200` with an `ETag` and `304` to the minute check; unknown tokens are `404`; `/drawings/` is not a listing; `POST` is refused; canaries are mapped; no other PDF is reachable in a station's folder (status `exposed`). Exit 0 / 2 / 1 like `verify`. Schedule it. |
| `windows/Find-CanaryHits.ps1` | The alarm: reads the IIS log and lists any request to a canary token or to a token that is not a station, with the client address. Exit 1 if it finds one. Schedule it hourly with an email or SIEM action. |
| `windows/BrixEdge.Common.psm1` | The logic the three scripts share: token validation, the root-containment rule, CIDR to subnet mask, stations.json reading, W3C log parsing, and the HTTP probe. |
| `windows/Test-BrixEdge.Common.ps1` | Unit tests for that module. They run anywhere PowerShell 7 runs, including a laptop: `pwsh -File windows/Test-BrixEdge.Common.ps1`. |

```powershell
.\Install-BrixEdgeIIS.ps1 -Root D:\Drawings -Stations D:\Drawings\stations.json -AllowFrom "10.50.0.0/16" -InstallIIS
.\Test-BrixEdge.ps1 -Stations D:\Drawings\stations.json -CanaryTokens scr_canary000000000000000
```

The address to save in Brix is then `http://<server ip>:8787/drawings/{{screen.id}}/` — keep the trailing slash; it is the folder whose default document is `released.pdf`.

Run the installer in an elevated **Windows PowerShell 5.1** (`powershell.exe`), not `pwsh` 7: `WebAdministration` and the `IIS:` drive are Windows-only and behave badly under PowerShell 7's compatibility shim. The scripts' shared logic is PowerShell 5.1-compatible.

**What is tested, and what is not.** `Test-BrixEdge.Common.ps1` proves the parts that are ours: token validation, the containment rule that keeps a mapped path inside your drawings tree, the CIDR to subnet-mask conversion behind `-AllowFrom`, stations.json reading, the W3C log parsing and canary classification, and the HTTP probe — the last of these against a running reference server, so the 200/ETag/304 sequence a screen performs is exercised rather than assumed. What those tests cannot cover is IIS itself: creating the site, the virtual directories, the IP restrictions and the firewall rule, and the header behaviour that comes from `web.config`. That is what `Test-BrixEdge.ps1` is for, and it has to run on the host.

**Keep only the drawing in a station's folder on IIS.** IIS serves `released.pdf` for `/drawings/<id>/`. It also serves any other `.pdf` in that folder, or below it, to a client that asks for it by name, for example `/drawings/<id>/old-rev.pdf`. IIS cannot stop this without the URL Rewrite module. A station mapped to a file is worse: its virtual directory is the file's parent folder. So map each station to its own folder. The installer warns and `Test-BrixEdge.ps1` fails when it finds another PDF. The Node server does not have this problem: it serves only the one chosen file.

What the IIS route gives up compared with the container: the "newest PDF wins" rule (IIS serves `released.pdf`, which is your "replace the exact file" workflow anyway) and the Prometheus counters (you have the IIS log and your own tooling instead). If you want the counters, run the Node server as a scheduled task at startup instead: `node src\edge.mjs start` with the same environment variables. No wrapper is needed.

A SIEM query for the canary, if you ingest IIS logs (Kusto):

```kusto
W3CIISLog
| where sSiteName == "BRIXEDGE"
| where csUriStem startswith "/drawings/scr_canary" or csUriStem !has_any (dynamic(["scr_9f2c","scr_3a1b"]))  // your station ids
| project TimeGenerated, cIP, csUriStem, scStatus, csUserAgent
```

**Two things to know about the screen's address gate.** The screen only fetches from private addresses: an IP in a private range, a name ending `.local`, `.internal` or `.home.arpa`, or a name under a DNS suffix Brix support has added to your account (for example `corp.example.com`, so that `edge.corp.example.com` is accepted). Ask for that if you want to use your own name; in every case the screen still connects only when the name resolves to a private address. And the screen honours a `301` from IIS (folder without slash to folder with slash), but saving the address with the trailing slash avoids the extra round trip every minute.

**Keeping the folder current is your side.** The IIS folder can be a OneDrive-synced folder, a DFS replica, or the target of a scheduled `robocopy /MIR` from wherever your released drawings live. Whatever you choose, the screen shows when its copy was fetched, and `Test-BrixEdge.ps1` shows the file date it is serving, so a stale copy is visible rather than silent.

## What it does not do

- It does not list folders to clients, and it does not serve arbitrary paths.
- It does not know or care what Brix shows on the screen. It serves one PDF per token.
- It does not render pages. The screen renders the PDF itself.
- It does not keep any state between restarts. The map and the folder are the state, and they are yours.
- It does not encrypt. Screens fetch over plain HTTP on your network, so anyone who can see that traffic can see the drawing. Keep the screens and the server on a network segment you control.
- It does not authenticate screens. A token is a screen id: Brix makes it from 74 random bits, so nobody can guess it, but it is not a password. Identity mode uses your folder names as tokens, and those are often easy to guess. Use map mode with screen ids when that matters.

## Licence

MIT. See `LICENSE`.
