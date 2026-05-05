FROM node:20-bookworm-slim

COPY --from=docker.io/cloudflare/sandbox:0.9.2 /container-server/sandbox /sandbox

WORKDIR /workspace

ENTRYPOINT ["/sandbox"]
