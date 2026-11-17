FROM node:24-bookworm-slim AS node
FROM opencode_100-agent:latest
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /opt/pac-test-npm
RUN mkdir -p /opt/pac-test-bin && ln -s /opt/pac-test-npm/bin/npm-cli.js /opt/pac-test-bin/npm
ENV PATH=/opt/pac-test-bin:$PATH
