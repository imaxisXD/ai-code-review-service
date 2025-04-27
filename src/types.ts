// src/types.ts
// Indexing job types
export interface IndexingJob {
  repoId: string;
  userId: string;
  jobType: 'initial' | 'incremental';
  serviceSecretKey: string;
}

// Processing result
export interface ProcessingResult {
  status: 'Success' | 'Failed';
  filesProcessed?: number;
  filesDeleted?: number;
  commitSha?: string;
  error?: string;
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
