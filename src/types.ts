// src/types.ts
// Indexing job types
export interface IndexingJob {
  repoId: string;
  userId: string;
  jobType: 'initial' | 'incremental';
  serviceSecretKey: string;
}

// PR Review job types
export interface PullRequestReviewJob {
  repoId: string;
  userId: string;
  jobType: 'pr_review';
  serviceSecretKey: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  commitSha: string;
  baseSha: string;
  installationId: number;
  owner: string;
  repo: string;
}

// Union type for all job types
export type Job = IndexingJob | PullRequestReviewJob;

// Processing result
export interface ProcessingResult {
  status: 'Success' | 'Failed';
  filesProcessed?: number;
  filesDeleted?: number;
  commitSha?: string;
  error?: string;
}

// PR Review result
export interface PullRequestReviewResult {
  status: 'Success' | 'Failed';
  reviewId?: string;
  commentsPosted?: number;
  error?: string;
}

// Review comment structure
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity: 'info' | 'warning' | 'error';
  category: string;
  suggestion?: string;
}

// Review summary
export interface ReviewSummary {
  overallScore: number; // 0-100
  totalIssues: number;
  criticalIssues: number;
  warningIssues: number;
  infoIssues: number;
  summary: string;
  recommendations: string[];
}

// Chunk types supported by the parsing system
export type ChunkType =
  // Basic types
  | 'code'
  | 'comment'
  | 'docs'
  // Symbol types
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'struct'
  | 'property'
  | 'arrow_function'
  | 'module'
  | 'enum'
  | 'component'
  | 'trait'
  // Import/require types
  | 'import'
  | 'require'
  | 'using'
  | 'namespace'
  | 'use';

// Embedding chunk
export interface EmbeddingChunk {
  codeChunkText: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: ChunkType;
  symbolName: string | null;
}

// Indexing status
export type IndexingStatus = 'pending' | 'started' | 'completed' | 'failed' | 'indexed';

// Git diff file change type
export type GitChangeType = 'A' | 'M' | 'D' | 'R';

// Git diff file
export interface GitDiffFile {
  file: string;
  changes: GitChangeType;
  insertions: number;
  deletions: number;
  binary?: boolean;
  from?: string;
  to?: string;
}

// Convex API function signatures (for type checking)
export interface ConvexApi {
  embeddings: {
    storeEmbedding: (args: {
      embedding: number[];
      metadata: {
        repositoryId: string;
        filePath: string;
        startLine: number;
        endLine: number;
        language: string;
        chunkType: string;
        symbolName: string | null;
        commitSha: string;
      };
    }) => Promise<string>;

    deleteEmbeddingsByPathBatch: (args: {
      repositoryId: string;
      filePaths: string[];
    }) => Promise<number>;
  };

  repositories: {
    updateLastIndexedCommit: (args: {
      repositoryId: string;
      commitSha: string;
      status: IndexingStatus;
    }) => Promise<void>;

    updateIndexingStatus: (args: {
      repositoryId: string;
      status: IndexingStatus;
      error?: string;
    }) => Promise<void>;
  };
}

// Relationship types for code dependency analysis
export type RelationshipType =
  | 'function_call'
  | 'import'
  | 'inheritance'
  | 'implementation'
  | 'usage'
  | 'composition';

// Code relationship representing a dependency between code entities
export interface CodeRelationship {
  type: RelationshipType;
  source: string;
  target: string;
  location: {
    filePath: string;
    startLine: number;
    endLine: number;
  };
  metadata?: Record<string, any>;
}

// Semantic type classification for code chunks
export type SemanticType =
  | 'unclassified'
  | 'authentication'
  | 'authorization'
  | 'data-access'
  | 'ui-component'
  | 'api-endpoint'
  | 'utility'
  | 'business-logic'
  | 'config'
  | 'test'
  | 'validation'
  | 'error-handling';

// Code complexity metrics
export interface ComplexityMetrics {
  cyclomaticComplexity: number; // Number of independent paths through code
  cognitiveComplexity: number; // How difficult the code is to understand
  linesOfCode: number; // Raw lines of code
  parameterCount?: number; // Number of parameters (for functions)
  nestingDepth?: number; // Maximum nesting depth
  dependencyCount: number; // Number of dependencies
  dependentCount: number; // Number of components depending on this
}

// Enhanced code chunk with semantic metadata
export interface EnhancedCodeChunk extends EmbeddingChunk {
  metadata: {
    dependencies: string[]; // Symbols this chunk depends on
    dependents: string[]; // Symbols that depend on this chunk
    semanticType: SemanticType; // Classified purpose of the code
    complexity: ComplexityMetrics; // Code complexity metrics
    changeFrequency: number; // How often this code changes (0-1)
    lastModified?: number; // Timestamp of last modification
    authors?: string[]; // List of authors who modified this chunk
    tags?: string[]; // Automatically generated tags
  };
}
