#!/usr/bin/env bash
# Reproducible image build. Builds the image from the commit you have checked
# out, with every timestamp set to that commit's time, and prints the image
# manifest digest. The same commit gives the same digest on any machine with
# Docker BuildKit (docker buildx), so you can compare your digest with the one
# in a release's notes and attestation without pulling anything from us.
#
#   scripts/reproduce.sh                 # prints sha256:...
#   scripts/reproduce.sh out.tar         # also keeps the OCI image as out.tar
#
# Needs: docker with the buildx plugin, git. Uses a docker-container builder
# (created as "brix-edge-repro" if the current builder cannot export OCI).
set -euo pipefail
cd "$(dirname "$0")/.."

out="${1:-}"
keep=1
if [ -z "$out" ]; then out="$(mktemp -d)/image.tar"; keep=0; fi

export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct HEAD)"

builder=()
if [ "$(docker buildx inspect --format '{{.Driver}}' 2>/dev/null || echo docker)" = docker ]; then
  docker buildx inspect brix-edge-repro >/dev/null 2>&1 || docker buildx create --name brix-edge-repro --driver docker-container >/dev/null
  builder=(--builder brix-edge-repro)
fi

docker buildx build "${builder[@]}" --quiet --no-cache \
  --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg SOURCE_DATE_EPOCH \
  --output "type=oci,dest=$out,rewrite-timestamp=true,oci-mediatypes=true" \
  . >/dev/null

digest="$(tar -xOf "$out" index.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);process.stdout.write(i.manifests[0].digest)})')"
[ "$keep" = 1 ] || rm -rf "$(dirname "$out")"
echo "$digest"
