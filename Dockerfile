# brix-edge — the on-premises drawing server for Brix sealed screens.
#
# Build it yourself from the tag you audited; do not pull an image from us:
#   docker build -t brix-edge:0.1.0 .
#
# REPRODUCIBILITY: pin the base image by DIGEST before you build for production
# (the tag below moves; a digest does not). Get it with
#   docker pull node:22-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine
# and replace the FROM line with  FROM node@sha256:<digest>
FROM node:22-alpine

# No package installation step: this program has no dependencies. What you
# audited in src/ is the whole of what runs.
WORKDIR /app
COPY package.json ./
COPY src ./src

# The drawings and the station map are YOUR files, mounted read-only:
#   -v /srv/drawings:/data/drawings:ro  -v /srv/stations.json:/data/stations.json:ro
ENV BRIX_EDGE_ROOT=/data/drawings \
    BRIX_EDGE_MAP=/data/stations.json \
    BRIX_EDGE_BIND=0.0.0.0 \
    BRIX_EDGE_PORT=8787

USER node
EXPOSE 8787

# The health check calls THIS container's own port. It is the only network
# call in the image, and it is inbound to itself.
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.BRIX_EDGE_PORT||8787)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/edge.mjs", "start"]
