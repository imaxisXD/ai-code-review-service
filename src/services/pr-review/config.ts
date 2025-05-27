import { ReviewConfig } from './types.js';

export const DEFAULT_CONFIG: ReviewConfig = {
  maxFilesPerReview: 15,
  maxLinesPerFile: 1000,
  maxCommentsPerFile: 8,
  skipPatterns: [
    'node_modules/**',
    '*.generated.*',
    '*.min.js',
    'dist/**',
    'build/**',
    '*.lock',
    'package-lock.json',
    'yarn.lock',
    '.cursor/**',
    '*.md',
    '*.mdc',
    '*.txt',
    '*.log',
    '.npmrc',
    '.prettierrc',
    '.prettierignore',
  ],
  embeddingConfig: {
    model: 'text-embedding-3-small',
    maxInputLength: 6000,
    similarCodeLimit: 3,
  },
  retryConfig: {
    maxRetries: 3, // Increase retries for rate limit handling
    baseDelayMs: 5000, // Start with 5 seconds
    maxDelayMs: 60000, // Max 1 minute delay
    enableJitter: true,
  },
  lineNumberValidation: {
    enabled: true,
    maxCorrectionDistance: 5,
    preferChangedLines: true,
  },
};

// Job deduplication cache constants
export const JOB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Rate limiting constants
export const RATE_LIMIT_DELAY = 1000; // 1 second between requests
export const MAX_RETRIES = 3;

/**
 * Check if a file should be skipped based on patterns
 */
export function shouldSkipFile(filePath: string, skipPatterns: string[]): boolean {
  return skipPatterns.some((pattern) => {
    // Convert glob pattern to regex for simple matching
    const regexPattern = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
    return new RegExp(regexPattern).test(filePath);
  });
}

/**
 * Get language from file path
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
  };
  return langMap[ext || ''] || 'text';
}
