# Pull Request Review Service - Modular Architecture

This directory contains the refactored Pull Request Review Service, broken down into focused, maintainable modules.

## Architecture Overview

The original large `pr-review-service.ts` file (2170+ lines) has been decomposed into the following modules:

### Core Modules

#### `index.ts` - Main Service Orchestrator

- **Purpose**: Main entry point and orchestration logic
- **Responsibilities**:
  - Job processing workflow
  - Module coordination
  - Error handling and logging
  - Public API surface

#### `types.ts` - Type Definitions

- **Purpose**: Shared interfaces and type definitions
- **Key Types**:
  - `ReviewConfig` - Service configuration
  - `ProcessedFile` - File processing results
  - `DiffAnalysis` - Git diff analysis results
  - `LLMAnalysisResult` - AI analysis output
  - `CircuitBreakerState` - Circuit breaker state

#### `config.ts` - Configuration & Utilities

- **Purpose**: Configuration management and utility functions
- **Features**:
  - Default configuration values
  - File skip patterns
  - Language detection
  - Rate limiting constants

### Processing Modules

#### `file-processor.ts` - File Content Processing

- **Purpose**: File content manipulation and preparation
- **Key Functions**:
  - `removeCommentsFromCodeWithTracking()` - Comment removal with line tracking
  - `createAnnotatedFileContentWithPositions()` - Line-numbered content generation
  - `reconstructContentFromPatch()` - Content reconstruction from patches
  - `cleanupRepository()` - Temporary file cleanup

#### `diff-analyzer.ts` - Git Diff Analysis

- **Purpose**: Git diff parsing and line number mapping
- **Key Functions**:
  - `parseGitHubPatch()` - GitHub patch format parsing
  - `validateAndCorrectLineNumbers()` - Line number validation and correction
- **Features**:
  - Accurate line-to-position mapping
  - Valid diff line identification
  - Line number correction algorithms

#### `llm-analyzer.ts` - AI-Powered Analysis

- **Purpose**: LLM integration for code analysis
- **Key Functions**:
  - `getSimilarCodeContext()` - Embedding-based context retrieval
  - `analyzeCodeWithLLM()` - Structured AI analysis with retry logic
- **Features**:
  - Anthropic Claude integration
  - Structured output with Zod schemas
  - Context-aware prompting
  - Retry logic with exponential backoff

### Integration Modules

#### `github-integration.ts` - GitHub API Integration

- **Purpose**: All GitHub API interactions
- **Key Functions**:
  - `extractChangedFilesFromGitHub()` - PR file extraction
  - `fetchExistingPRComments()` - Comment deduplication
  - `postCommentsToGitHub()` - Batch comment posting
- **Features**:
  - GitHub App authentication
  - Rate limiting protection
  - Fallback mechanisms
  - Individual comment posting

#### `comment-manager.ts` - Comment Management

- **Purpose**: Comment processing and validation
- **Key Functions**:
  - `convertAnalysisToComments()` - LLM output to GitHub comments
  - `filterDuplicateComments()` - Duplicate detection and removal
  - `validateCommentsForGitHub()` - GitHub API validation
  - `generateReviewSummary()` - Review summary generation

#### `circuit-breaker.ts` - Resilience & Retry Logic

- **Purpose**: API overload protection and retry mechanisms
- **Features**:
  - Circuit breaker pattern implementation
  - Exponential backoff with jitter
  - Overload error detection
  - Status monitoring

## Key Improvements

### 1. **Separation of Concerns**

Each module has a single, well-defined responsibility:

- File processing is isolated from GitHub integration
- LLM analysis is separate from comment management
- Configuration is centralized and reusable

### 2. **Improved Testability**

- Individual modules can be unit tested in isolation
- Dependencies are clearly defined through imports
- Mock-friendly interfaces for external services

### 3. **Better Maintainability**

- Smaller, focused files are easier to understand and modify
- Clear module boundaries reduce coupling
- Consistent error handling patterns

### 4. **Enhanced Readability**

- Each file has a clear purpose and scope
- Related functionality is grouped together
- Comprehensive documentation and comments

### 5. **Scalability**

- New features can be added to specific modules
- Modules can be optimized independently
- Easy to add new processing steps or integrations

## Usage

The service maintains the same public API:

```typescript
import { createPullRequestReviewService } from './pr-review-service.js';

const service = createPullRequestReviewService({
  convex,
  openai,
  config: {
    maxFilesPerReview: 10,
    // ... other config options
  },
});

const result = await service.processPullRequestReview(job);
```

## Configuration

The service accepts the same configuration options as before, now centralized in `config.ts`:

```typescript
interface ReviewConfig {
  maxFilesPerReview: number;
  maxLinesPerFile: number;
  maxCommentsPerFile: number;
  skipPatterns: string[];
  embeddingConfig: {
    model: string;
    maxInputLength: number;
    similarCodeLimit: number;
  };
  retryConfig: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    enableJitter: boolean;
  };
  lineNumberValidation: {
    enabled: boolean;
    maxCorrectionDistance: number;
    preferChangedLines: boolean;
  };
}
```

## Migration Notes

- **No Breaking Changes**: The public API remains unchanged
- **Backward Compatibility**: All existing functionality is preserved
- **Performance**: No performance impact, potentially improved due to better organization
- **Dependencies**: All existing dependencies are maintained

This modular architecture provides a solid foundation for future enhancements while maintaining the robust functionality of the original service.
