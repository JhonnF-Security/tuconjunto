# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files
COPY server/package*.json ./server/
RUN cd server && npm ci --only=production

# Copy source
COPY server/ ./server/
COPY deploy/ ./deploy/

# ---- Runtime stage ----
FROM node:20-alpine
WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init sqlite

# Copy from builder
COPY --from=builder /app/server ./server
COPY --from=builder /app/deploy ./deploy

# Create data directory with proper permissions
RUN mkdir -p /app/server/data && chown -R node:node /app

# Switch to non-root user
USER node

# Expose port
EXPOSE 8081

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8081/api/health', (r) => { if (r.statusCode !== 200) process.exit(1) }).on('error', () => process.exit(1))"

# Start
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/src/index.js"]
