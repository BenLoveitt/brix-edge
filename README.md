# brix-edge

The on-premises drawing server for Brix **sealed screens**. It runs on a server you own, inside your network, and does one thing: when a screen asks for the drawing that belongs to it, it serves the current released PDF from a folder you control.

It opens **no outbound connection**. It never talks to Brix. Block it from the internet entirely and nothing about it changes.

## Prove it before you run it

Nothing here needs an account, a licence key or a call to us.

```bash
node --test                              # 26 tests: routing, containment, the 304, the canary
pwsh -File windows/Test-BrixEdge.Common.ps1   # 26 more, if you are taking the IIS route
```

Then read `src/` — five files, no dependencies — and `windows/web.config`, which is the whole IIS configuration in one page. `test/no-egress.test.mjs` fails the suite if any outbound network primitive appears in `src/`, so the "it never calls home" claim is enforced by the tests rather than asserted in this file.

## What it is for

A Brix screen on a sealed account stores no drawing, no thumbnail and no page render in Brix. The screen fetches the document itself, from your network, and renders it on the device. What Brix holds about a station is a **screen id** and an address template such as:

```
http://brix-edge.plant.example:8787/drawings/{{screen.id}}
```

The template expands on each screen to its own id. This server maps that id to a folder in your file tree and serves whatever is released there. **No file name, part number or drawing ever enters Brix.** Which station builds which part is written in a JSON file on your server, or driven by your own systems.

When you replace the file, every screen picks up the new copy within a minute and shows when its copy was fetched.

## Run it

```bash
docker build -t brix-edge:0.1.0 .
docker run -d --name brix-edge \
  -p 8787:8787 \
  -v /srv/drawings:/data/drawings:ro \
  -v /srv/stations.json:/data/stations.json:ro \
  -e BRIX_EDGE_CANARY_TOKENS=scr_canary000000000000000 \
  brix-edge:0.1.0
```

Or without Docker: `BRIX_EDGE_ROOT=/srv/drawings BRIX_EDGE_MAP=/srv/stations.json node src/edge.mjs start`. Node 20 or later, no dependencies.

Check the configuration before you trust it:

```bash
docker exec brix-edge node src/edge.mjs verify
```

`verify` lists every mapped station and what it resolves to. Exit 0 means every station has a drawing; 2 means a station has nothing released; 1 means a mapping is broken.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `BRIX_EDGE_ROOT` | The folder that holds the drawings. Mount it read-only. | required |
| `BRIX_EDGE_MAP` | JSON file: `{ "<screen id>": "<folder or file under ROOT>" }`. Without it the server runs in **identity mode**: the token is a folder name directly under ROOT. | none |
| `BRIX_EDGE_CANARY_TOKENS` | Comma-separated tokens that no screen is ever given. A request for one is an alarm. | none |
| `BRIX_EDGE_RELEASED_NAME` | The file that wins inside a station folder when present. Otherwise the newest `*.pdf` is served. | `released.pdf` |
| `BRIX_EDGE_MAX_BYTES` | Refuse a drawing larger than this. The screen has the same cap. | 32 MiB |
| `BRIX_EDGE_BIND`, `BRIX_EDGE_PORT` | Where to listen. | `0.0.0.0`, `8787` |

See `stations.example.json`.

## How a station's drawing is chosen

1. The token must be in the map (or, in identity mode, must be a folder name under ROOT). Anything else is `unknown` and counted.
2. The mapped path must stay inside ROOT. `..`, absolute paths and symlinks that lead out are refused and counted. They are never served.
3. If the path is a file, that is the drawing. If it is a folder, `released.pdf` wins when present; otherwise the newest `*.pdf` by modification time.
4. A folder with no PDF is **nothing released**: a 404 with the header `x-brix-edge-reason: nothing-released`, counted. The screen shows a card instead of a drawing.

## What it sends

For `GET /drawings/<token>`:

- `Content-Type: application/pdf`, `Content-Length`
- `ETag: "sha256:<hash of the file>"` and `Last-Modified`
- `Cache-Control: no-store`

The screen re-checks every minute with `If-None-Match`. An unchanged drawing costs a `304` with no body. There is no file name in any response. Only `GET` and `HEAD` exist; there are no other routes except `/healthz` and `/metrics`.

## How you verify it, every day, without asking us

**Your access log is the record.** Every request is one JSON line on stdout: time, remote address, token, status, bytes, and the file that was served. Ship it to your SIEM. It is written by software you run, and we cannot edit it.

**Metrics** at `/metrics` (Prometheus text). Alert on:

| Metric | Alert when |
|---|---|
| `brix_edge_canary_requests_total` | above 0. Something asked for a token no screen was given. |
| `brix_edge_unknown_token_total` | rising. A typo in the map, or a probe. |
| `brix_edge_no_released_total` | rising. A station whose folder is empty. |
| `brix_edge_last_served_timestamp_seconds{token}` | older than you expect. A screen that stopped asking stopped checking. |
| `brix_edge_up` | absent. The container is down. |

**No outbound connections.** Three ways to satisfy yourself, none of which involve trusting this file:

1. Read `src/`. Five files. The only network module imported is `node:http`, and only `createServer` from it. `node --test` runs `test/no-egress.test.mjs`, which fails on any outbound primitive in `src/`.
2. Run the container on a network with no route out, or with an egress-deny rule. Nothing changes.
3. Watch its connections: `docker exec brix-edge cat /proc/net/tcp` shows only listening sockets and inbound connections from your screens.

**The canary.** Map a token that you never give to any screen (the example maps `scr_canary000000000000000` to a `canary/` folder). Put a distinctive PDF there. If `brix_edge_canary_requests_total` ever moves, or that file's name ever appears in a log line, something other than your screens is asking, and you have the address it came from.

**Build it yourself.** Do not pull an image from us. Build from a tag you have read, and pin the base image by digest (see the `Dockerfile`). There is no install step and no lockfile because there are no dependencies: what you read is what runs.

## Microsoft shop? Run it on IIS, with nothing of ours on your server

If you run Windows Server, you do not need the container or Node. IIS already does everything the screen needs, natively: the default document, `ETag` and `Last-Modified` with `304` on a conditional request, request filtering, IP restrictions, and W3C logs your SIEM already reads. The `windows/` folder holds the whole setup:

| File | What it does |
|---|---|
| `windows/web.config` | The site's entire configuration, in one reviewable file: only `released.pdf` is a default document, no directory listing, only `GET` and `HEAD`, only `.pdf`, static file handler only, `Cache-Control: no-store`, empty error bodies. |
| `windows/Install-BrixEdgeIIS.ps1` | Creates the site and one virtual directory per screen id from your `stations.json`, restricts it to the screens' subnets (IIS and Windows Firewall), turns on W3C logging with the fields that matter, and prints the address to save in Brix. Idempotent: rerun after you edit the JSON. |
| `windows/Test-BrixEdge.ps1` | Proves it: every station answers `200` with an `ETag` and `304` to the minute check; unknown tokens are `404`; `/drawings/` is not a listing; `POST` is refused; canaries are mapped. Exit 0 / 2 / 1 like `verify`. Schedule it. |
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

## Licence

MIT. See `LICENSE`.
