# BotiX AI Repair
FROM node:22-bookworm-slim

# git: work on the code copies. Claude Code: the AI that investigates and fixes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code --no-audit --no-fund \
 && useradd --create-home --uid 10001 runner

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public

# The server stays root only so it can start Claude Code and the tests as the separate
# "runner" user – that user cannot read the server's secrets.
ENV NODE_ENV=production DATA_DIR=/data RUNNER_USER=runner
EXPOSE 3000
CMD ["node", "src/index.js"]
