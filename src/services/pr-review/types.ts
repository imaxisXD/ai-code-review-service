import { ReviewComment } from '../../types.js';

export interface ReviewConfig {
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

export interface CircuitBreakerState {
  isOpen: boolean;
  failureCount: number;
  lastFailureTime: number;
  resetTimeoutMs: number;
  maxFailures: number;
}

export interface DiffAnalysis {
  changedLines: Set<number>;
  addedLines: Set<number>;
  deletedLines: Set<number>;
  validDiffPositions: Set<number>;
  validDiffLines: Set<number>;
  lineToPositionMap: Map<number, number>;
  positionToLineMap: Map<number, number>;
}

export interface ProcessedFile {
  path: string;
  content: string;
  originalContent: string;
  annotatedContent: string;
  patch: string;
  diff: string;
  language: string;
  diffAnalysis: DiffAnalysis;
  commentLines: Set<number>;
  isNewFile: boolean;
  isDeletedFile: boolean;
  githubFile: any;
}

export interface LLMAnalysisResult {
  summary: string;
  issues: Array<{
    line: number;
    severity: 'critical' | 'warning' | 'info';
    category: 'security' | 'bug' | 'performance' | 'maintainability';
    message: string;
    suggestion: string;
    explanation: string;
  }>;
}

export interface ExistingComment {
  path: string;
  line: number;
  body: string;
}

export interface CommentValidationResult {
  validComments: ReviewComment[];
  invalidComments: Array<{ comment: ReviewComment; reason: string }>;
}

export interface CircuitBreakerStatus {
  isOpen: boolean;
  failureCount: number;
  lastFailureTime: number;
  timeUntilReset: number;
}
