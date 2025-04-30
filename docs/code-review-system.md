# Code Review System Architecture

## System Overview

This document outlines the architecture and workflow of our intelligent PR review system that uses code embeddings, vector similarity, and LLMs to provide high-quality automated code reviews.

## Database Schema

Our system is built on a Convex database. For detailed schema information, please refer to the [Database Schema Documentation](./database-schema.md).

## System Workflow

```
┌────────────────┐           ┌────────────────┐           ┌────────────────┐
│                │           │                │           │                │
│ Repository     │──────────▶│ Code Indexing  │──────────▶│ Vector Storage │
│ Integration    │           │ Service        │           │ (Embeddings)   │
│                │           │                │           │                │
└────────────────┘           └────────────────┘           └────────────────┘
        │                                                          │
        │                                                          │
        ▼                                                          ▼
┌────────────────┐           ┌────────────────┐           ┌────────────────┐
│                │           │                │           │                │
│ PR Webhook     │──────────▶│ Diff Analysis  │◀───────── │ Semantic Code  │
│ Handler        │           │ Service        │           │ Search         │
│                │           │                │           │                │
└────────────────┘           └────────────────┘           └────────────────┘
                                     │
                                     │
                                     ▼
                             ┌────────────────┐           ┌────────────────┐
                             │                │           │                │
                             │ LLM Review     │──────────▶│ Comment        │
                             │ Generation     │           │ Integration    │
                             │                │           │                │
                             └────────────────┘           └────────────────┘
```

## Core Components

### 1. Repository Integration Service

Connects to GitHub/Bitbucket repositories and manages:

- Repository setup and configuration
- Authentication and access control
- Webhook registration
- Repository status tracking

```typescript
// Example repository setup flow
async function setupRepository(repositoryId, userId, provider, accessToken) {
  // Register repository in database
  // Set up webhooks
  // Configure initial settings
  // Trigger initial code indexing
}
```

### 2. Code Indexing Service

Processes repository code to create embeddings:

- Clone repository or fetch changes
- Parse code into semantic chunks
- Generate vector embeddings
- Store in database with metadata

```typescript
// Example indexing flow
async function indexRepository(repositoryId, commitSha, jobType) {
  // Clone repository to temp directory
  // Process files to extract code chunks
  // Generate embeddings for chunks
  // Store in codeEmbeddings and codeChunks tables
  // Update repository status
}
```

### 3. PR Review Pipeline

Processes pull requests to generate intelligent reviews:

- Receive webhook events for PR creation/updates
- Extract diff information
- Use vector similarity to find relevant code patterns
- Leverage LLMs for deep analysis
- Post comments to PR

```typescript
// Example PR review flow
async function reviewPullRequest(repositoryId, prNumber, diffContent) {
  // Create review record
  // Extract changed files and lines
  // Find similar code patterns using embeddings
  // Generate LLM context with relevant information
  // Process with specialized LLM prompts
  // Post comments and summary
}
```

### 4. Vector Similarity Search

Uses embeddings to find relevant code:

- Search for similar code patterns
- Find related modules and functions
- Identify repeated patterns and inconsistencies

```typescript
// Example vector search
async function findSimilarCode(repositoryId, codeSnippet, language) {
  // Generate embedding for code snippet
  // Query vector index for similar code
  // Retrieve full context from codeChunks table
  // Return relevant similar code segments
}
```

### 5. LLM Analysis Service

Processes code with large language models:

- Generate specialized prompts for bug detection
- Analyze code against best practices
- Generate improvement suggestions
- Create summaries and severity ratings

```typescript
// Example LLM analysis
async function analyzeDiffWithLLM(diffContent, similarCodeContext, customRules) {
  // Prepare context with diff and similar code
  // Apply custom analysis rules
  // Generate prompt with specialized instructions
  // Process with LLM
  // Parse response into structured comments
}
```

### 6. Custom Rules Engine

Allows customization of the review process:

- User-defined patterns and rules
- Organization-specific best practices
- Severity and category classification
- Suggestion templates

```typescript
// Example rule application
async function applyCustomRules(code, organizationId) {
  // Retrieve rules for organization
  // Check code against patterns
  // Generate custom feedback based on matches
}
```

## Key Workflows

### Repository Indexing

1. Repository is registered in the system
2. Initial indexing job is created
3. Code is cloned, parsed into chunks
4. Chunks are embedded and stored with metadata
5. For incremental updates, only changed files are processed

### Pull Request Review

1. PR webhook is received
2. Review job is created in `reviews` table
3. Changed files are analyzed
4. Similar code is found using embeddings
5. Code is analyzed by LLMs with context
6. Comments are generated and posted
7. Summary and score are updated

### Custom Rule Creation

1. User creates custom analysis rule
2. Rule is stored in `analysisRules` table
3. Rule is applied in subsequent reviews
4. Results are tracked for effectiveness

## Implementation Guidelines

### Code Embedding Strategy

- **Chunking Strategy**: Balance between too small (losing context) and too large (losing specificity)
- **Embedding Model**: OpenAI Ada embedding model (1536 dimensions)
- **Storage Optimization**: Split embeddings from metadata for efficient querying
- **Incremental Updates**: Process only changed files for efficiency

### LLM Prompting Strategy

- **Context Enrichment**: Include similar code, repository patterns
- **Specialized Instructions**: Target specific bug types and issues
- **Multi-pass Analysis**: Use multiple prompts for different aspects
- **Feedback Loop**: Incorporate user feedback to improve prompts

### Performance Considerations

- **Batched Processing**: Process files in batches to manage memory
- **Query Optimization**: Use appropriate indexes for common queries
- **Caching**: Cache embeddings and analysis results where appropriate
- **Rate Limiting**: Respect API rate limits for LLMs and Git providers

### Security Considerations

- **Token Management**: Secure storage of access tokens
- **Code Isolation**: Process code in isolated environments
- **Data Minimization**: Only store necessary repository data
- **Permission Checking**: Verify user permissions for all operations

<!-- ## API Endpoints

### Repository Management

- `POST /api/repositories` - Register new repository
- `GET /api/repositories/:id` - Get repository details
- `PATCH /api/repositories/:id/settings` - Update repository settings

### Review Operations

- `POST /api/webhooks/:provider` - Webhook endpoint for PR events
- `GET /api/reviews/:id` - Get review details and comments
- `POST /api/reviews/:id/feedback` - Submit feedback on review

### Custom Rules

- `POST /api/rules` - Create custom analysis rule
- `GET /api/rules` - List analysis rules
- `DELETE /api/rules/:id` - Delete analysis rule -->

## Future Enhancements

1. **Learning System**: Track which comments were accepted/rejected
2. **Multi-model Analysis**: Compare results from different LLMs
3. **CI/CD Integration**: Run reviews automatically on CI/CD pipelines
4. **Team Analytics**: Track common issues by team/repository
5. **Automated Fixes**: Generate and propose automatic fixes for common issues
6. **Code Quality Trends**: Track quality metrics over time

## PR Review Flow Implementation

### Using Code Embeddings for Contextual Review

The system leverages existing code embeddings to provide context-aware reviews:

1.  **Detect PR Changes**:

    - When a PR is created/updated, identify changed files via webhooks
    - Process the changed files to generate embeddings for the new code

2.  **Semantic Code Search**:

    - For each changed block, use embeddings to find similar code patterns
    - Query vector store for relevant code context:

      ```typescript
      const similarCode = await db.query.codeEmbeddings.withIndex('by_embedding', q =>
        q
          .filter({ repositoryId: repo._id })
          .vectorSearch('embedding', newCodeEmbedding, { numResults: 5 })
      );

      // Get metadata for the similar chunks
      const similarChunks = await Promise.all(
        similarCode.map(embedding =>
          db.query.codeChunks.withIndex('by_embedding', q =>
            q.filter({ embeddingId: embedding._id })
          )
        )
      );
      ```

3.  **Context Building for LLM**:

    - Combine PR diff with similar code pieces from the repository
    - Include relevant file paths, function names, and repository patterns
    - Apply custom organization rules from the `analysisRules` table

4.  **LLM Integration**:

    - Generate specialized prompts with contextual information:

           ```typescript
           const prompt = `
           Review the following code changes:
           ${prDiff}

           Similar existing code patterns in the codebase:
           ${similarChunks
             .map(
               chunk => `

      File: ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine})
      ${fetchCodeContent(chunk.filePath, chunk.startLine, chunk.endLine)}
      `
      )
      .join('\n')}

           Provide a code review focusing on:
           1. Consistency with existing patterns
           2. Potential bugs or issues
           3. Performance concerns
           4. Security vulnerabilities
           `;

           const review = await callLLM(prompt);
           ```

5.  **Post Review Comments**:
    - Use provider-specific APIs (GitHub/GitLab) to post line-specific comments
    - Group related suggestions for better readability
    - Include severity ratings and suggested fixes where appropriate

## Advanced Bug Detection Strategies

### Cost and Performance Impact Detection

The system can be enhanced to detect issues with significant operational impact:

1. **Analytics and Tracking Overuse**:

   - Detect events added to high-frequency UI elements (banners, headers)
   - Flag potential cost increases for third-party analytics (PostHog, Segment, etc.)
   - Example rule:
     ```typescript
     {
       name: "High-frequency analytics events",
       pattern: /trackEvent|posthog\.capture|analytics\.track/,
       contextCheck: (code, filePath) => {
         // Check if code is within components that appear on every page
         return isHighFrequencyComponent(filePath, code);
       },
       severity: "high",
       message: "Analytics event in high-frequency component may increase costs significantly"
     }
     ```

2. **Memory Leak Detection**:

   - Identify event listeners or subscriptions without cleanup
   - Flag incomplete React useEffect cleanup functions
   - Detect DOM references stored outside component lifecycle

3. **State Management Anti-patterns**:

   - Identify redux/zustand/context updates in render functions
   - Detect potential re-render cascades
   - Flag unnecessary state for static data

4. **API Usage Patterns**:
   - Correlate backend API definitions with frontend usage
   - Detect unnecessary or duplicate API calls
   - Flag potential N+1 query patterns

### Learning-Based Improvements

Implement feedback loops to continuously improve detection:

1. **User Feedback Collection**:

   - Track accepted vs. rejected suggestions
   - Collect explicit feedback on review quality
   - Store in `reviewFeedback` table with suggestion IDs

2. **Repository-Specific Learning**:

   - Build custom embeddings for project-specific patterns
   - Generate specialized rules based on common feedback
   - Adjust severity ratings based on team priorities

3. **Historical Bug Correlation**:

   - Connect with issue tracker to find historical bugs
   - Train detection models on past issues
   - Prioritize checks for recurring issue types

4. **Custom Analysis Rules UI**:
   - Allow teams to define their own detection patterns
   - Create organization-level rule libraries
   - Share effective rules across projects
