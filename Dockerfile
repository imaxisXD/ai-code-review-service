# Use Node.js LTS 
FROM node:20-slim

# Install git, build-essentials and security updates
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /workspace

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (including dev dependencies for build)
RUN npm install --include=dev

RUN npm install -g @google-cloud/functions-framework


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

# Create a startup script
RUN echo '#!/bin/sh\nset -e\necho "Starting server with: functions-framework --target=httpHandler --port=${PORT:-8080}"\nexec functions-framework --target=httpHandler --port=${PORT:-8080}' > /workspace/start.sh && \
    chmod +x /workspace/start.sh

# Define the command to start the Functions Framework
CMD exec functions-framework --target=httpHandler --port=${PORT:-8080} 