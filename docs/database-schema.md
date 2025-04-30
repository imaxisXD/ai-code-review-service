# Code Review System Convex Database Schema

This document details the database schema used by our code review system, implemented using Convex.

## Core Tables

### User Management

- **`users`**: Core user information and authentication

  ```typescript
  users: defineTable({
    name: v.string(),
    email: v.string(),
    image: v.optional(v.string()),
    clerkId: v.string(),
  }).index('by_clerk_id', ['clerkId']);
  ```

- **`organizations`**: User groupings for team management
  ```typescript
  organizations: defineTable({
    name: v.string(),
    ownerId: v.id('users'),
    createdAt: v.number(),
  }).index('by_owner', ['ownerId']);
  ```

### Repository Management

- **`repositories`**: GitHub/Bitbucket repositories with configuration

  ```typescript
  repositories: defineTable({
    repositoryId: v.number(),
    userId: v.id('users'),
    provider: v.string(), // "github" or "bitbucket"
    name: v.string(),
    repositoryName: v.string(),
    description: v.string(),
    cloneUrl: v.string(),
    sshUrl: v.string(),
    language: v.string(),
    hooksUrl: v.string(),
    mainBranch: v.string(),
    url: v.string(),
    isPrivate: v.boolean(),
    isEnabled: v.boolean(),
    accessToken: v.string(),
    lastSyncedAt: v.string(),
    webhookId: v.optional(v.string()),
    updatedAt: v.optional(v.string()),
    commitSha: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal('pending'),
        v.literal('started'),
        v.literal('completed'),
        v.literal('failed'),
        v.literal('indexed')
      )
    ),
    settings: v.object({
      autoReview: v.boolean(),
      addComments: v.boolean(),
      notifyOnCompletion: v.boolean(),
    }),
  })
    .index('by_user_and_repository', ['userId', 'repositoryId'])
    .index('by_user', ['userId'])
    .index('by_provider_id', ['provider', 'repositoryId']);
  ```

- **`backgroundJobs`**: Asynchronous job tracking
  ```typescript
  backgroundJobs: defineTable({
    repositoryId: v.id('repositories'),
    status: v.union(
      v.literal('pending'),
      v.literal('started'),
      v.literal('completed'),
      v.literal('failed')
    ),
  }).index('by_repository', ['repositoryId']);
  ```

### Review System

- **`reviews`**: Top-level PR review metadata

  ```typescript
  reviews: defineTable({
    repositoryId: v.id('repositories'),
    prNumber: v.number(),
    prTitle: v.string(),
    prUrl: v.string(),
    commitSha: v.string(),
    status: v.string(), // "pending", "completed", "failed"
    score: v.optional(v.number()),
    startedAt: v.string(),
    completedAt: v.optional(v.string()),
    summary: v.optional(v.string()),
    issues: v.array(
      v.object({
        id: v.string(),
        type: v.string(),
        severity: v.string(),
        file: v.string(),
        line: v.number(),
        message: v.string(),
        suggestion: v.optional(v.string()),
      })
    ),
  })
    .index('by_repository', ['repositoryId'])
    .index('by_repository_and_pr', ['repositoryId', 'prNumber']);
  ```

- **`reviewAnalyses`**: Analysis results for pull requests

  ```typescript
  reviewAnalyses: defineTable({
    pullRequestId: v.id('pullRequests'),
    status: v.string(), // "pending", "completed", "failed"
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    summary: v.optional(v.string()),
    score: v.optional(v.number()), // 0-100 quality score
    errorMessage: v.optional(v.string()),
  }).index('by_pull_request', ['pullRequestId']);
  ```

- **`reviewComments`**: Individual comments on code issues
  ```typescript
  reviewComments: defineTable({
    reviewAnalysisId: v.id('reviewAnalyses'),
    path: v.string(), // file path
    line: v.number(), // line number
    content: v.string(), // comment content
    severity: v.string(), // "info", "warning", "error"
    category: v.string(), // "bug", "security", "performance", "style", etc.
    suggestedFix: v.optional(v.string()),
    createdAt: v.number(),
    postedToProvider: v.boolean(), // whether it's posted to GitHub/Bitbucket
    providerCommentId: v.optional(v.string()), // ID of the comment on GitHub/Bitbucket
  }).index('by_review_analysis', ['reviewAnalysisId']);
  ```

## Code Vectorization

- **`codeEmbeddings`**: Vector embeddings of code chunks

  ```typescript
  codeEmbeddings: defineTable({
    embedding: v.array(v.float64()),
    repositoryId: v.id('repositories'),
    language: v.optional(v.string()),
    createdAt: v.number(),
  }).vectorIndex('by_embedding', {
    vectorField: 'embedding',
    dimensions: 1536, // OpenAI embedding dimensions
    filterFields: ['repositoryId', 'language'],
  });
  ```

- **`codeChunks`**: Metadata for code segments
  ```typescript
  codeChunks: defineTable({
    embeddingId: v.id('codeEmbeddings'),
    repositoryId: v.id('repositories'),
    filePath: v.string(),
    startLine: v.number(),
    endLine: v.number(),
    commitSha: v.string(),
    language: v.optional(v.string()),
    chunkType: v.optional(v.string()),
    symbolName: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_embedding', ['embeddingId'])
    .index('by_repository', ['repositoryId'])
    .index('by_path', ['repositoryId', 'filePath']);
  ```

## Customization

- **`analysisRules`**: User-defined rules for code analysis
  ```typescript
  analysisRules: defineTable({
    name: v.string(),
    description: v.string(),
    organizationId: v.optional(v.id('organizations')),
    userId: v.id('users'),
    pattern: v.string(), // regex or description of what to look for
    severity: v.string(), // "info", "warning", "error"
    category: v.string(), // "bug", "security", "performance", "style", etc.
    suggestion: v.string(), // template for suggested fix
    createdAt: v.number(),
    isEnabled: v.boolean(),
  })
    .index('by_user', ['userId'])
    .index('by_organization', ['organizationId']);
  ```

## Database Design Considerations

### Vector Search Optimization

The system uses a separate table approach for vector storage:

- `codeEmbeddings` stores just the vector data and minimal filtering fields
- `codeChunks` stores all the metadata associated with each chunk

This separation allows for:

1. More efficient vector searches
2. Reduced storage requirements in the vector index
3. Better query performance for metadata-only operations

### Indexing Strategy

Carefully designed indexes enable fast queries for common access patterns:

- Repository-based filtering
- Path-based lookups
- Embedding-to-metadata joins
- User-specific queries

### Data Relationships

The schema maintains clear relationships between entities:

- Users own repositories
- Repositories have reviews
- Reviews contain comments
- Code chunks reference embeddings
- Rules can be scoped to organizations or users
