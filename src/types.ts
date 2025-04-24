// src/types.ts
// Indexing job types
export interface IndexingJob {
  repoId: string;
  repoUrl: string;
  jobType: 'initial' | 'incremental';
  beforeSha?: string;
  afterSha?: string;
}

// Processing result
export interface ProcessingResult {
  status: 'Success' | 'Failed';
  filesProcessed?: number;
  filesDeleted?: number;
  commitSha?: string;
  error?: string;
}

// Embedding chunk
export interface EmbeddingChunk {
  codeChunkText: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: 'code' | 'comment' | 'docs';
  symbolName: string | null;
}

// Indexing status
export type IndexingStatus = 'Pending' | 'Processing' | 'Indexed' | 'Failed';

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