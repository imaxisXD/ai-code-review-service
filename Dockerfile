# Use Node.js LTS 
FROM node:20-slim

# Install git, build-essentials, ca-certificates and security updates
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
    ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Update CA certificates
RUN update-ca-certificates

# Set the working directory
WORKDIR /workspace

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (including dev dependencies for build)
RUN npm install --include=dev --legacy-peer-deps

RUN npm install -g @google-cloud/functions-framework --legacy-peer-deps

# Copy TypeScript configuration
COPY tsconfig.json ./

# Copy source code
COPY src/ ./src/

# Build TypeScript code
RUN npm run build

# Make sure dist directory is accessible from the root directory
RUN ln -s /workspace/dist /dist

# Set environment variables
ENV NODE_ENV=production
ENV NODE_PATH=/workspace
ENV DEBUG=*

# Create a startup script with more debugging
RUN echo '#!/bin/sh\nset -e\necho "Current directory: $(pwd)"\necho "Directory contents: $(ls -la)"\necho "Node version: $(node -v)"\necho "Starting server with: functions-framework --target=httpHandler --port=${PORT:-8080} --host=0.0.0.0"\nexec functions-framework --target=httpHandler --port=${PORT:-8080} --host=0.0.0.0' > /workspace/start.sh && \
    chmod +x /workspace/start.sh

# Define the command to start the Functions Framework
CMD ["/workspace/start.sh"] 