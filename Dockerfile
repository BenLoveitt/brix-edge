# brix-edge — the on-premises drawing server for Brix sealed screens.
#
# Build it yourself from the tag you audited:
#   docker build -t brix-edge:0.2.0 .
#
# The base image is pinned by DIGEST, so the same Dockerfile always starts from
# the same bytes. It is Google's distroless Node.js 22 image: Node and its
# runtime libraries, and nothing else. There is no shell, no package manager
# and no npm in it. It runs as user 65532 ("nonroot"). To check the digest:
#   docker pull gcr.io/distroless/nodejs22-debian12:nonroot
#   docker inspect --format='{{index .RepoDigests 0}}' gcr.io/distroless/nodejs22-debian12:nonroot
# Dependabot proposes a new digest when Google publishes one (.github/dependabot.yml).
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

# No package installation step: this program has no dependencies. What you
# audited in src/ is the whole of what runs. The files belong to root and the
# process cannot change them.
WORKDIR /app
COPY package.json ./
COPY src ./src

# The drawings and the station map are YOUR files, mounted read-only:
#   -v /srv/drawings:/data/drawings:ro  -v /srv/stations.json:/data/stations.json:ro
ENV BRIX_EDGE_ROOT=/data/drawings \
    BRIX_EDGE_MAP=/data/stations.json \
    BRIX_EDGE_BIND=0.0.0.0 \
    BRIX_EDGE_PORT=8787

USER 65532:65532
EXPOSE 8787

# The health check calls THIS container's own port. It is the only network
# call in the image, and it is inbound to itself. Exec form: there is no shell.
HEALTHCHECK --interval=30s --timeout=3s CMD ["/nodejs/bin/node", "-e", "require('http').get('http://127.0.0.1:'+(process.env.BRIX_EDGE_PORT||8787)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

ENTRYPOINT ["/nodejs/bin/node", "src/edge.mjs"]
CMD ["start"]
