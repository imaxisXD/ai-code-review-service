# Git Repository Indexing Worker

A TypeScript implementation of a Git Repository Indexing Worker that runs on Google Cloud Functions (Gen 2). This worker handles both initial repository indexing and incremental updates, following the "Clone -> Embed -> Store Embedding -> Delete Clone" strategy.

## Architecture

This worker is designed to:

1. Clone Git repositories securely using access tokens
2. Process files to generate embeddings
3. Store embeddings and metadata in a Convex database
4. Clean up temporary files to maintain function resources

## Features

- **TypeScript** for full type safety and improved developer experience
- **Modular architecture** with separate services for Git operations, embedding generation, and file processing
- **Comprehensive logging** with different log levels
- **Error handling** with automatic retries for embedding generation
- **Support for both initial and incremental indexing**
- **Memory-efficient processing** with batched operations
- **Proper cleanup** to avoid resource leaks

## Prerequisites

- Node.js 18+ and npm
- Google Cloud CLI
- Docker (for local testing)
- Convex account and project

## Setup & Deployment

### 1. Clone this repository

```bash
git clone https://github.com/yourusername/git-repo-indexer.git
cd git-repo-indexer
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build the TypeScript code

```bash
npm run build
```

### 4. Local testing with Functions Framework

```bash
npm run dev
```

### 5. Deploy to Google Cloud Functions (Gen 2)

```bash
# Build the container image using Cloud Build
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/git-repo-indexer:latest .

# Deploy the Cloud Function
gcloud functions deploy git-repo-indexer \
   --gen2 \
   --region=YOUR_REGION \
   --source=. \
   --entry-point=httpHandler \
   --trigger-http \
   --memory=1024MB \
   --timeout=3600s \
   --cpu=1 \
   --container-image=gcr.io/YOUR_PROJECT_ID/git-repo-indexer:latest \
   --set-env-vars=CONVEX_URL=YOUR_CONVEX_URL,LOG_LEVEL=info \
   --set-secrets=GITHUB_TOKEN=github-token:latest,OPENAI_API_KEY=openai-api-key:latest
```

### 6. Set up authentication (recommended)

For production use, configure authentication using Google Cloud IAM:

```bash
# Remove public access
gcloud functions remove-iam-policy-binding git-repo-indexer \
  --member=allUsers \
  --role=roles/cloudfunctions.invoker \
  --region=YOUR_REGION

# Grant invoker role to specific service account
gcloud functions add-iam-policy-binding git-repo-indexer \
  --member=serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com \
  --role=roles/cloudfunctions.invoker \
  --region=YOUR_REGION
```

## Usage

Send a POST request to the function endpoint with a JSON body:

```json
{
  "repoId": "unique-repo-identifier",
  "repoUrl": "https://github.com/username/repo.git",
  "jobType": "initial",
  "beforeSha": null,
  "afterSha": null
}
```

For incremental updates:

```json
{
  "repoId": "unique-repo-identifier",
  "repoUrl": "https://github.com/username/repo.git",
  "jobType": "incremental",
  "beforeSha": "previous-commit-sha",
  "afterSha": null
}
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `CONVEX_URL` | Convex deployment URL | Yes |
| `CONVEX_DEPLOYMENT_KEY` | Convex deployment key | Yes |
| `GITHUB_TOKEN` | GitHub personal access token | For private GitHub repos |
| `OPENAI_API_KEY` | OpenAI API key | Yes |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | No (default: info) |

## Project Structure

```
git-repo-indexer/
├── src/                      # Source code
│   ├── index.ts              # Main function handler
│   ├── types.ts              # TypeScript type definitions
│   ├── services/             # Service modules
│   │   ├── git-service.ts    # Git operations
│   │   ├── embedding-service.ts # Embedding generation
│   │   └── file-processor-service.ts # File processing
│   └── utils/
│       └── logger.ts         # Logging utility
├── tests/                    # Jest tests
├── dist/                     # Compiled JavaScript (generated)
├── Dockerfile                # Container definition
├── package.json              # npm dependencies
├── tsconfig.json             # TypeScript configuration
└── README.md                 # This file
```

## Further Improvements

- Add a frontend dashboard for monitoring indexing jobs
- Implement more sophisticated code parsing using tree-sitter
- Add support for more embedding providers
- Implement rate limiting and queue processing for large repositories
- Add more comprehensive test coverage