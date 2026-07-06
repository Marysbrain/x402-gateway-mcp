# Container for directory sandboxes (Glama et al.) that verify the server
# starts and answers MCP introspection. stdio transport; tools/list works
# with no env at all (tool list derives from the public gateway manifest,
# fetched at startup — outbound HTTPS required). Paid calls additionally
# need WALLET_PRIVATE_KEY at runtime.
FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY package-lock.json* ./
COPY src ./src
RUN (test -f package-lock.json && npm ci || npm install --no-audit --no-fund) \
    && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
