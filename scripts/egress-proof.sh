#!/usr/bin/env bash
# Egress proof: run brix-edge in a container that has NO network at all
# (--network none: only a loopback interface, no route anywhere), and show that
# it still serves a drawing. Then show that the container cannot reach anything
# outside, and that its only sockets are its own listener and loopback.
#
# Run it yourself:   scripts/egress-proof.sh            (builds brix-edge:proof)
#                    scripts/egress-proof.sh my-image   (checks an image you built)
# Needs: docker, node 20+. Exit 0 = every check passed. CI runs it on every push.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
image="${1:-}"
if [ -z "$image" ]; then
  image="brix-edge:proof"
  docker build -q -t "$image" "$here" >/dev/null
fi

work="$(mktemp -d)"
name="brix-edge-proof-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

mkdir -p "$work/drawings/station-1"
node --input-type=module -e "
  import { pdfBytes } from '$here/test/helpers.mjs';
  import { writeFileSync } from 'node:fs';
  writeFileSync('$work/drawings/station-1/released.pdf', pdfBytes('EGRESS PROOF'));
  writeFileSync('$work/stations.json', JSON.stringify({ scr_proof0000000000000000: 'station-1' }));
"
chmod -R a+rX "$work"

docker run -d --name "$name" \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$work/drawings:/data/drawings:ro" -v "$work/stations.json:/data/stations.json:ro" \
  "$image" >/dev/null

in_box() { docker exec "$name" /nodejs/bin/node -e "$1"; }
pass=0; fail=0
check() { if [ "$2" = "ok" ]; then echo "  ok    $1"; pass=$((pass+1)); else echo "  FAIL  $1 ($2)"; fail=$((fail+1)); fi; }

for _ in $(seq 1 50); do
  in_box "require('http').get('http://127.0.0.1:8787/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null && break
  sleep 0.2
done

echo "brix-edge egress proof — image $image"
echo "  container: $(docker inspect -f 'network={{.HostConfig.NetworkMode}} user={{.Config.User}} read-only-root={{.HostConfig.ReadonlyRootfs}} cap-drop={{.HostConfig.CapDrop}}' "$name")"

check "network mode is none" "$( [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$name")" = none ] && echo ok || echo "not none")"
check "runs as a non-root user" "$( [ "$(docker inspect -f '{{.Config.User}}' "$name")" != "" ] && [ "$(docker inspect -f '{{.Config.User}}' "$name")" != "0" ] && echo ok || echo root)"

ifaces="$(in_box "const t=require('fs').readFileSync('/proc/net/dev','utf8').split('\n').slice(2).map(l=>l.split(':')[0].trim()).filter(Boolean);console.log(t.join(','))")"
check "the only network interface is loopback (found: $ifaces)" "$( [ "$ifaces" = lo ] && echo ok || echo "$ifaces")"

served="$(in_box "fetch('http://127.0.0.1:8787/drawings/scr_proof0000000000000000').then(async r=>{const b=Buffer.from(await r.arrayBuffer());console.log(r.status+' '+b.subarray(0,5).toString('latin1')+' '+b.includes('EGRESS PROOF'))})")"
check "with no network it still serves the drawing (got: $served)" "$( [ "$served" = "200 %PDF- true" ] && echo ok || echo "$served")"

out="$(in_box "fetch('http://1.1.1.1/',{signal:AbortSignal.timeout(3000)}).then(()=>console.log('reached'),e=>console.log('refused'))")"
check "nothing outside is reachable from inside the container" "$( [ "$out" = refused ] && echo ok || echo "$out")"

# Every socket in /proc/net/tcp{,6}: local and remote address. A connection out
# would show a remote address that is not loopback or 0.0.0.0.
sockets="$(in_box "
  const fs=require('fs');const bad=[];
  for (const f of ['/proc/net/tcp','/proc/net/tcp6','/proc/net/udp','/proc/net/udp6']) {
    let t=''; try { t=fs.readFileSync(f,'utf8'); } catch { continue; }
    for (const l of t.trim().split('\n').slice(1)) {
      const rem=l.trim().split(/\s+/)[2].split(':')[0];
      const ok=/^0+$/.test(rem)||rem==='0100007F'||/^0{24}01000000$/.test(rem)||/^0{20}FFFF00000100007F$/i.test(rem)||rem==='00000000000000000000000001000000';
      if(!ok) bad.push(f+' '+l.trim());
    }
  }
  console.log(bad.length?bad.join(' | '):'none');
")"
check "no socket has a remote address other than loopback (found: $sockets)" "$( [ "$sockets" = none ] && echo ok || echo "$sockets")"

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
