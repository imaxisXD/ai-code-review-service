# Use Node.js 23 slim (matches your previous image)
FROM node:23-slim AS base

# Install git and essential packages
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
    ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Update CA certificates
RUN update-ca-certificates

# Configure git with the same settings as your previous setup
# These settings match what your git-service.ts expects
RUN git config --global credential.helper cache \
    && git config --global http.postBuffer 1048576000 \
    && git config --global http.lowSpeedLimit 1000 \
    && git config --global http.lowSpeedTime 60 \
    && git config --global url."https://".insteadOf git://

FROM base AS builder
WORKDIR /workspace

# Copy package.json and lock file
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies with the same flags as before
RUN npm install --include=dev --legacy-peer-deps

# Copy source code
COPY src/ ./src/

# Build TypeScript code
RUN npm run build

# Prune dev dependencies for production
RUN npm prune --production --legacy-peer-deps

FROM base AS runner
WORKDIR /workspace

# Create non-root user for better security
RUN groupadd -r nodejs -g 1001 && \
    useradd -r -g nodejs -u 1001 codereviewer

# Copy built files and dependencies from builder
COPY --from=builder --chown=codereviewer:nodejs /workspace/node_modules /workspace/node_modules
COPY --from=builder --chown=codereviewer:nodejs /workspace/dist /workspace/dist
COPY --from=builder --chown=codereviewer:nodejs /workspace/package.json /workspace/package.json

# Create symlink for backward compatibility if needed
RUN ln -s /workspace/dist /dist

# Set environment variables
ENV NODE_ENV=production
ENV NODE_PATH=/workspace
ENV DEBUG=*
ENV NODE_OPTIONS=--experimental-specifier-resolution=node

# Create a startup script with debugging info
RUN echo '#!/bin/sh\nset -e\necho "Current directory: $(pwd)"\necho "Directory contents: $(ls -la)"\necho "Node version: $(node -v)"\necho "Starting Hono server on port 8080"\nexec node /workspace/dist/index.js' > /workspace/start.sh && \
    chmod +x /workspace/start.sh

# Change ownership of start script
RUN chown codereviewer:nodejs /workspace/start.sh

# Switch to non-root user
USER codereviewer
EXPOSE 8080

# Use the debug startup script
CMD ["/workspace/start.sh"]