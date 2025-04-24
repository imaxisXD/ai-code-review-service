# Use Node.js LTS 
FROM node:20-slim

# Install git and build-essentials
RUN apt-get update && apt-get install -y --no-install-recommends \
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
RUN npm install

# Copy TypeScript configuration
COPY tsconfig.json ./

# Copy source code
COPY src/ ./src/

# Build TypeScript code
RUN npm run build

# Define the command to start the Functions Framework
CMD exec functions-framework --target=httpHandler --port=8080