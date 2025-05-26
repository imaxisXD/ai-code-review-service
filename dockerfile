# Use Node.js 23 slim with better caching strategy
FROM node:23-slim AS base

# Install system dependencies in a single layer with cleanup
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
    ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && update-ca-certificates

# Install pnpm globally for faster dependency management
RUN npm install -g pnpm@latest

# Configure git with optimized settings
RUN git config --global credential.helper cache \
    && git config --global http.postBuffer 1048576000 \
    && git config --global http.lowSpeedLimit 1000 \
    && git config --global http.lowSpeedTime 60 \
    && git config --global url."https://".insteadOf git://

# Dependencies stage - separate for better caching
FROM base AS deps
WORKDIR /workspace

# Copy package management files first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Install dependencies with pnpm (much faster than npm)
# Use frozen lockfile for reproducible builds and enable parallel downloads
RUN pnpm config set store-dir /root/.pnpm-store \
    && pnpm install --frozen-lockfile --prefer-offline

# Build stage
FROM base AS builder
WORKDIR /workspace

# Copy dependencies from deps stage
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/package.json ./package.json

# Copy source files and build configuration
COPY tsconfig.json ./
COPY src/ ./src/

# Build the application
RUN pnpm run build

# Production dependencies stage
FROM base AS prod-deps
WORKDIR /workspace

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Install only production dependencies
RUN pnpm config set store-dir /root/.pnpm-store \
    && pnpm install --frozen-lockfile --prod --prefer-offline

# Final runtime stage optimized for Cloud Run
FROM base AS runner
WORKDIR /workspace

# Create non-root user for security (Cloud Run best practice)
RUN groupadd -r nodejs -g 1001 && \
    useradd -r -g nodejs -u 1001 codereviewer

# Copy production dependencies and built application
COPY --from=prod-deps --chown=codereviewer:nodejs /workspace/node_modules ./node_modules
COPY --from=builder --chown=codereviewer:nodejs /workspace/dist ./dist
COPY --from=builder --chown=codereviewer:nodejs /workspace/package.json ./package.json

# Create symlink for backward compatibility
RUN ln -s /workspace/dist /dist

# Set environment variables optimized for Cloud Run
ENV NODE_ENV=production \
    NODE_PATH=/workspace \
    NODE_OPTIONS="--experimental-specifier-resolution=node --max-old-space-size=512" \
    PORT=8080

# Create startup script optimized for Cloud Run
RUN echo '#!/bin/sh\nset -e\necho "🚀 Starting Hono server on Cloud Run..."\necho "📁 Working directory: $(pwd)"\necho "📦 Node version: $(node -v)"\necho "🔧 Environment: $NODE_ENV"\necho "🌐 Server starting on port $PORT"\nexec node /workspace/dist/index.js' > /workspace/start.sh \
    && chmod +x /workspace/start.sh \
    && chown codereviewer:nodejs /workspace/start.sh

# Switch to non-root user
USER codereviewer

# Expose the port that Cloud Run expects
EXPOSE 8080

# Use the startup script
CMD ["/workspace/start.sh"]