import { ConvexHttpClient } from 'convex/browser';
import OpenAI from 'openai';
import { createGitService } from './git-service.js';
import { api } from '../convex/api.js';
import { logger } from '../utils/logger.js';
import { PullRequestReviewJob, ReviewComment, PullRequestReviewResult } from '../types.js';
// SimpleGit import removed - now using GitHub API instead of git operations
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';

/**
 * Pull Request Review Service
 *
 * This service handles automated code review for pull requests using AI.
 *
 * LINE NUMBER ACCURACY IMPROVEMENTS:
 *
 * The service implements several sophisticated techniques to ensure accurate line numbers in review comments:
 *
 * 1. DIFF PARSING AND ANALYSIS:
 *    - parseDiffForLineRanges(): Parses git diffs to extract exact line changes
 *    - Identifies added, deleted, and modified lines with precise line numbers
 *    - Creates line mapping between old and new file versions
 *
 * 2. COMMENT FILTERING WITH TRACKING:
 *    - removeCommentsFromCodeWithTracking(): Removes comments while tracking their line numbers
 *    - Prevents AI from reviewing documentation/comments
 *    - Maintains accurate line number mapping after comment removal
 *
 * 3. ANNOTATED CONTENT GENERATION:
 *    - createAnnotatedFileContent(): Creates line-numbered content with change annotations
 *    - Marks lines as [ADDED LINE], [MODIFIED LINE], or [COMMENT LINE - FILTERED]
 *    - Provides clear visual indicators to the AI about which lines changed
 *
 * 4. LINE NUMBER VALIDATION AND CORRECTION:
 *    - validateAndCorrectLineNumbers(): Post-processes AI responses to fix line numbers
 *    - Corrects line numbers that point to comment lines
 *    - Prefers lines that were actually changed in the PR
 *    - Validates line numbers are within file bounds
 *    - Configurable correction distance and preferences
 *
 * 5. ENHANCED AI PROMPTING:
 *    - Explicit instructions to use annotated line numbers
 *    - Focus on changed lines only ([ADDED LINE] or [MODIFIED LINE])
 *    - Clear guidance on line number format and expectations
 *
 * 6. CONFIGURATION OPTIONS:
 *    - lineNumberValidation.enabled: Enable/disable line number correction
 *    - lineNumberValidation.maxCorrectionDistance: Max lines to search for corrections
 *    - lineNumberValidation.preferChangedLines: Prefer lines that were actually changed
 *
 * This multi-layered approach significantly improves line number accuracy while maintaining
 * the quality and relevance of AI-generated code review comments.
 *
 * RETRY AND CIRCUIT BREAKER FUNCTIONALITY:
 *
 * The service implements robust error handling for Anthropic API overload errors (HTTP 529):
 *
 * 1. RETRY MECHANISM:
 *    - Configurable retry attempts (default: 5)
 *    - Exponential backoff with optional jitter
 *    - Base delay: 2 seconds, max delay: 30 seconds
 *    - Specifically handles "Overloaded" errors from Anthropic API
 *
 * 2. CIRCUIT BREAKER PATTERN:
 *    - Opens circuit after 3 consecutive overload failures
 *    - Prevents further API calls for 1 minute when open
 *    - Automatically resets after timeout period
 *    - Protects against cascading failures and API abuse
 *
 * 3. CONFIGURATION:
 *    - retryConfig.maxRetries: Number of retry attempts
 *    - retryConfig.baseDelayMs: Base delay between retries
 *    - retryConfig.maxDelayMs: Maximum delay between retries
 *    - retryConfig.enableJitter: Add randomness to prevent thundering herd
 *
 * 4. MONITORING:
 *    - Detailed logging of retry attempts and circuit breaker state
 *    - getCircuitBreakerStatus() function for monitoring
 *    - Graceful degradation with informative error messages
 *
 * This ensures the service remains resilient during Anthropic API overload periods
 * while providing clear feedback about the system state.
 */

// Configuration for AI code review
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

const DEFAULT_CONFIG: ReviewConfig = {
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
    maxInputLength: 8000,
    similarCodeLimit: 5,
  },
  retryConfig: {
    maxRetries: 1, // Enable retries for LLM analysis - Pub/Sub will handle job-level retries
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    enableJitter: true,
  },
  lineNumberValidation: {
    enabled: true,
    maxCorrectionDistance: 5,
    preferChangedLines: true,
  },
};

export function createPullRequestReviewService(deps: {
  convex: ConvexHttpClient;
  openai: OpenAI;
  config?: Partial<ReviewConfig>;
}) {
  const { convex, openai, config: userConfig } = deps;
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  // Circuit breaker state for handling API overload
  const circuitBreakerState = {
    isOpen: false,
    failureCount: 0,
    lastFailureTime: 0,
    resetTimeoutMs: 60000, // 1 minute
    maxFailures: 3, // Open circuit after 3 consecutive overload failures
  };

  // Job deduplication cache to prevent processing the same job multiple times
  const processedJobs = new Map<string, { timestamp: number; result: any }>();
  const JOB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  /**
   * Improved comment removal that tracks which lines were comments
   */
  function removeCommentsFromCodeWithTracking(
    content: string,
    language: string
  ): {
    filteredContent: string;
    commentLines: Set<number>;
  } {
    const lines = content.split('\n');
    const filteredLines: string[] = [];
    const commentLines = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      const lineNumber = i + 1;

      // Skip empty lines
      if (!trimmedLine) {
        filteredLines.push(line);
        continue;
      }

      // Language-specific comment detection
      let isComment = false;

      switch (language) {
        case 'javascript':
        case 'typescript':
        case 'java':
        case 'kotlin':
        case 'swift':
        case 'go':
        case 'rust':
        case 'cpp':
        case 'c':
        case 'csharp':
          // Single line comments
          if (trimmedLine.startsWith('//')) {
            isComment = true;
          }
          // Multi-line comments (simple detection)
          if (
            trimmedLine.startsWith('/*') ||
            trimmedLine.startsWith('*') ||
            trimmedLine.endsWith('*/')
          ) {
            isComment = true;
          }
          // JSDoc comments
          if (trimmedLine.startsWith('/**') || trimmedLine.startsWith('*')) {
            isComment = true;
          }
          break;

        case 'python':
          // Single line comments
          if (trimmedLine.startsWith('#')) {
            isComment = true;
          }
          // Docstrings (simple detection)
          if (trimmedLine.startsWith('"""') || trimmedLine.startsWith("'''")) {
            isComment = true;
          }
          break;

        case 'ruby':
          // Single line comments
          if (trimmedLine.startsWith('#')) {
            isComment = true;
          }
          break;

        case 'php':
          // Single line comments
          if (trimmedLine.startsWith('//') || trimmedLine.startsWith('#')) {
            isComment = true;
          }
          // Multi-line comments
          if (
            trimmedLine.startsWith('/*') ||
            trimmedLine.startsWith('*') ||
            trimmedLine.endsWith('*/')
          ) {
            isComment = true;
          }
          break;

        default:
          // For unknown languages, try to detect common comment patterns
          if (
            trimmedLine.startsWith('//') ||
            trimmedLine.startsWith('#') ||
            trimmedLine.startsWith('/*') ||
            trimmedLine.startsWith('*') ||
            trimmedLine.startsWith('<!--')
          ) {
            isComment = true;
          }
          break;
      }

      // If it's not a comment, include the line
      if (!isComment) {
        filteredLines.push(line);
      } else {
        // Replace comment lines with empty lines to maintain line numbers
        commentLines.add(lineNumber);
        filteredLines.push('');
      }
    }

    return {
      filteredContent: filteredLines.join('\n'),
      commentLines,
    };
  }

  /**
   * Validate and correct line numbers based on actual file content and changes
   * Ensures that line numbers correspond to lines that are part of the diff
   */
  function validateAndCorrectLineNumbers(
    issues: Array<{
      line: number;
      severity: 'critical' | 'warning' | 'info';
      category: 'security' | 'bug' | 'performance' | 'maintainability';
      message: string;
      suggestion: string;
      explanation: string;
    }>,
    fileContent: string,
    changedLines: Set<number>,
    addedLines: Set<number>,
    commentLines: Set<number>,
    validDiffLines: Set<number>
  ): Array<{
    line: number;
    severity: 'critical' | 'warning' | 'info';
    category: 'security' | 'bug' | 'performance' | 'maintainability';
    message: string;
    suggestion: string;
    explanation: string;
  }> {
    const totalLines = fileContent.split('\n').length;
    const validatedIssues: Array<{
      line: number;
      severity: 'critical' | 'warning' | 'info';
      category: 'security' | 'bug' | 'performance' | 'maintainability';
      message: string;
      suggestion: string;
      explanation: string;
    }> = [];

    for (const issue of issues) {
      let correctedLine = issue.line;

      // Ensure line number is within file bounds
      if (correctedLine < 1) {
        correctedLine = 1;
      } else if (correctedLine > totalLines) {
        correctedLine = totalLines;
      }

      // CRITICAL: Ensure the line is part of the diff (GitHub requirement)
      if (!validDiffLines.has(correctedLine)) {
        // Try to find the nearest valid diff line
        let nearestValidLine = correctedLine;
        let minDistance = Infinity;

        // First, prefer changed lines (added or modified)
        for (const validLine of validDiffLines) {
          if (changedLines.has(validLine)) {
            const distance = Math.abs(validLine - correctedLine);
            if (distance < minDistance) {
              minDistance = distance;
              nearestValidLine = validLine;
            }
          }
        }

        // If no changed lines found within reasonable distance, try any valid diff line
        if (minDistance > config.lineNumberValidation.maxCorrectionDistance) {
          minDistance = Infinity;
          for (const validLine of validDiffLines) {
            const distance = Math.abs(validLine - correctedLine);
            if (distance < minDistance) {
              minDistance = distance;
              nearestValidLine = validLine;
            }
          }
        }

        // If we found a valid line within reasonable distance, use it
        if (
          minDistance <= config.lineNumberValidation.maxCorrectionDistance &&
          nearestValidLine !== correctedLine
        ) {
          logger.info('Corrected line number to valid diff line', {
            originalLine: correctedLine,
            correctedLine: nearestValidLine,
            distance: minDistance,
            reason: 'Original line not part of diff',
          });
          correctedLine = nearestValidLine;
        } else {
          // Cannot find a valid line within reasonable distance, skip this comment
          logger.warn('Skipping comment - no valid diff line found', {
            originalLine: correctedLine,
            maxDistance: config.lineNumberValidation.maxCorrectionDistance,
            nearestDistance: minDistance,
            validDiffLinesCount: validDiffLines.size,
            message: issue.message.substring(0, 100),
          });
          continue; // Skip this issue
        }
      }

      // If the line is a comment line, try to find the nearest non-comment valid line
      if (commentLines.has(correctedLine)) {
        // Look for the nearest valid diff line that's not a comment
        let nearestValidLine = correctedLine;
        let minDistance = Infinity;

        for (const validLine of validDiffLines) {
          if (!commentLines.has(validLine)) {
            const distance = Math.abs(validLine - correctedLine);
            if (distance < minDistance) {
              minDistance = distance;
              nearestValidLine = validLine;
            }
          }
        }

        // If we found a better line within reasonable distance, use it
        if (
          minDistance <= config.lineNumberValidation.maxCorrectionDistance &&
          nearestValidLine !== correctedLine
        ) {
          logger.info('Corrected line number from comment line', {
            originalLine: correctedLine,
            correctedLine: nearestValidLine,
            reason: 'Original line was a comment',
          });
          correctedLine = nearestValidLine;
        }
      }

      // Prefer lines that were actually changed (if enabled and line is still valid)
      if (
        config.lineNumberValidation.preferChangedLines &&
        !changedLines.has(correctedLine) &&
        changedLines.size > 0 &&
        validDiffLines.has(correctedLine) // Ensure we don't break the diff requirement
      ) {
        // Find the nearest changed line that's also a valid diff line
        let nearestChangedLine = correctedLine;
        let minDistance = Infinity;

        for (const changedLine of changedLines) {
          if (validDiffLines.has(changedLine)) {
            const distance = Math.abs(changedLine - correctedLine);
            if (distance < minDistance) {
              minDistance = distance;
              nearestChangedLine = changedLine;
            }
          }
        }

        // If the nearest changed line is within configured distance, use it
        if (minDistance <= config.lineNumberValidation.maxCorrectionDistance) {
          logger.info('Corrected line number to nearest changed line', {
            originalLine: correctedLine,
            correctedLine: nearestChangedLine,
            distance: minDistance,
          });
          correctedLine = nearestChangedLine;
        }
      }

      // Final validation: ensure the corrected line is still valid
      if (validDiffLines.has(correctedLine)) {
        validatedIssues.push({
          ...issue,
          line: correctedLine,
        });
      } else {
        logger.warn('Final validation failed - skipping comment', {
          originalLine: issue.line,
          correctedLine,
          message: issue.message.substring(0, 100),
        });
      }
    }

    const skippedCount = issues.length - validatedIssues.length;
    if (skippedCount > 0) {
      logger.info('Line number validation summary', {
        originalIssues: issues.length,
        validatedIssues: validatedIssues.length,
        skippedIssues: skippedCount,
        validDiffLinesCount: validDiffLines.size,
      });
    }

    return validatedIssues;
  }

  /**
   * Fetch existing comments on a PR to avoid duplicates
   */
  async function fetchExistingPRComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<Array<{ path: string; line: number; body: string }>> {
    try {
      // Fetch review comments (line-specific comments)
      const reviewComments = await octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
      });

      // Fetch general PR comments
      const issueComments = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
      });

      const existingComments: Array<{ path: string; line: number; body: string }> = [];

      // Process review comments (these have file path and line number)
      for (const comment of reviewComments.data) {
        if (comment.path && comment.line && comment.body) {
          existingComments.push({
            path: comment.path,
            line: comment.line,
            body: comment.body,
          });
        }
      }

      // Process issue comments (these don't have specific line numbers)
      for (const comment of issueComments.data) {
        if (comment.body) {
          existingComments.push({
            path: '', // General PR comment, not file-specific
            line: 0,
            body: comment.body,
          });
        }
      }

      logger.info('Fetched existing PR comments', {
        reviewComments: reviewComments.data.length,
        issueComments: issueComments.data.length,
        total: existingComments.length,
      });

      return existingComments;
    } catch (error) {
      logger.warn('Failed to fetch existing PR comments', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check if a comment is similar to existing comments to avoid duplicates
   */
  function isDuplicateComment(
    newComment: ReviewComment,
    existingComments: Array<{ path: string; line: number; body: string }>
  ): boolean {
    for (const existing of existingComments) {
      // Check for exact path and line match
      if (existing.path === newComment.path && existing.line === newComment.line) {
        // Check if the comment is from our AI (has the signature)
        if (existing.body.includes('🤖 Generated by Migaki AI')) {
          logger.info('Skipping duplicate AI comment', {
            path: newComment.path,
            line: newComment.line,
          });
          return true;
        }

        // Check for similar content (simple similarity check)
        const existingWords = existing.body.toLowerCase().split(/\s+/);
        const newWords = newComment.body.toLowerCase().split(/\s+/);
        const commonWords = existingWords.filter((word) => newWords.includes(word));
        const similarity = commonWords.length / Math.max(existingWords.length, newWords.length);

        // If more than 60% similar, consider it a duplicate
        if (similarity > 0.6) {
          logger.info('Skipping similar comment', {
            path: newComment.path,
            line: newComment.line,
            similarity: Math.round(similarity * 100) + '%',
          });
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Filter out duplicate comments
   */
  function filterDuplicateComments(
    comments: ReviewComment[],
    existingComments: Array<{ path: string; line: number; body: string }>
  ): ReviewComment[] {
    const filteredComments = comments.filter(
      (comment) => !isDuplicateComment(comment, existingComments)
    );

    const duplicatesRemoved = comments.length - filteredComments.length;
    if (duplicatesRemoved > 0) {
      logger.info('Filtered out duplicate comments', {
        original: comments.length,
        filtered: filteredComments.length,
        duplicatesRemoved,
      });
    }

    return filteredComments;
  }

  /**
   * Check if a file should be skipped based on patterns
   */
  function shouldSkipFile(filePath: string): boolean {
    return config.skipPatterns.some((pattern) => {
      // Convert glob pattern to regex for simple matching
      const regexPattern = pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.');
      return new RegExp(regexPattern).test(filePath);
    });
  }

  /**
   * Process a pull request review job
   */
  async function processPullRequestReview(
    job: PullRequestReviewJob
  ): Promise<PullRequestReviewResult> {
    const {
      repoId,
      prNumber,
      prTitle,
      prUrl,
      commitSha,
      baseSha,
      installationId,
      owner,
      repo,
      userId,
    } = job;

    // Create unique job identifier for deduplication
    const jobId = `${repoId}-${prNumber}-${commitSha}`;

    // Check if this job was recently processed
    const now = Date.now();
    const cachedResult = processedJobs.get(jobId);
    if (cachedResult && now - cachedResult.timestamp < JOB_CACHE_TTL) {
      logger.info('Job already processed recently, returning cached result', {
        jobId,
        cachedTimestamp: new Date(cachedResult.timestamp).toISOString(),
        ageMinutes: Math.round((now - cachedResult.timestamp) / 60000),
      });
      return cachedResult.result;
    }

    let cloneDir = '';

    try {
      logger.info('Starting PR review', {
        repoId,
        prNumber,
        owner,
        repo,
        commitSha: commitSha.substring(0, 7),
        baseSha: baseSha.substring(0, 7),
        jobId,
      });

      // Step 1: Get repository details
      const repository = await convex.query(api.repositories.getRepositoryWithStringId, {
        repositoryId: repoId,
        userId: userId,
      });

      if (!repository) {
        throw new Error(`Repository not found: ${repoId}`);
      }

      // Check embedding availability for this repository
      try {
        // Use a simple search to check if any embeddings exist for this repository
        const testEmbedding = new Array(1536).fill(0); // Create a dummy embedding vector
        const embeddingCheck = await convex.action(api.embeddings.searchSimilarCode, {
          embedding: testEmbedding,
          repositoryId: repository._id as any,
          limit: 1,
        });

        if (embeddingCheck && embeddingCheck.length > 0) {
          logger.info('Repository has embeddings available', {
            repositoryId: repository._id,
            message: 'AI review will include similar code context from existing embeddings',
          });
        } else {
          logger.warn('Repository has no embeddings', {
            repositoryId: repository._id,
            message:
              'AI review will proceed without similar code context. Consider running repository indexing first.',
          });
        }
      } catch (error) {
        logger.warn('Could not check embedding availability', {
          repositoryId: repository._id,
          error: error instanceof Error ? error.message : String(error),
          message: 'AI review will proceed but may lack context',
        });
      }

      // Step 2: Create review record in database
      const reviewId = await convex.mutation(api.github.createPullRequestReview, {
        repositoryId: repository._id,
        prNumber,
        prTitle,
        prUrl,
        commitSha,
      });

      // Step 3: Clone repository and get PR diff
      cloneDir = `/tmp/pr-review-${repo}-${prNumber}-${Date.now()}`;
      const gitService = createGitService({
        githubToken: repository.accessToken,
      });

      const repoGit = await gitService.cloneRepository(repository.cloneUrl, cloneDir);

      // Checkout the PR commit
      await gitService.checkout(repoGit, commitSha);

      // Get the diff between base and head
      const diffSummary = await gitService.getDiffSummary(repoGit, baseSha, commitSha);
      logger.info('Got PR diff', {
        filesChanged: diffSummary.files.length,
        insertions: diffSummary.insertions,
        deletions: diffSummary.deletions,
      });

      // Step 4: Extract changed files and their content
      const changedFiles = await extractChangedFilesFromGitHub(
        new Octokit({
          authStrategy: createAppAuth,
          auth: {
            appId: process.env.GITHUB_APP_ID,
            privateKey: process.env.GITHUB_PRIVATE_KEY,
            installationId,
          },
        }),
        owner,
        repo,
        prNumber
      );

      if (changedFiles.length === 0) {
        logger.info('No files to review in PR', { prNumber });
        return {
          status: 'Success',
          reviewId: reviewId.reviewId,
          commentsPosted: 0,
        };
      }

      // Step 5: Generate code review using LLM
      logger.info('Starting code review generation', {
        filesCount: changedFiles.length,
        circuitBreakerStatus: getCircuitBreakerStatus(),
        fileDetails: changedFiles.map((f) => ({
          path: f.path,
          language: f.language,
          contentLength: f.content?.length || 0,
          hasChanges: f.diffAnalysis?.changedLines?.size || 0,
        })),
      });
      const { comments: reviewComments, fileValidDiffLines } = await generateCodeReview(
        changedFiles,
        repository
      );

      logger.info('Code review generation completed', {
        totalComments: reviewComments.length,
        commentsByFile: reviewComments.reduce(
          (acc, comment) => {
            acc[comment.path] = (acc[comment.path] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        ),
      });

      // Step 6: Post comments to GitHub
      const commentsPosted = await postCommentsToGitHub(
        installationId,
        owner,
        repo,
        prNumber,
        reviewComments,
        commitSha,
        fileValidDiffLines
      );

      logger.info('PR review completed', {
        prNumber,
        commentsPosted: commentsPosted.length,
        reviewId: reviewId.reviewId,
        jobId,
      });

      const result: PullRequestReviewResult = {
        status: 'Success' as const,
        reviewId: reviewId.reviewId,
        commentsPosted: commentsPosted.length,
      };

      // Cache successful result to prevent reprocessing
      processedJobs.set(jobId, {
        timestamp: now,
        result,
      });

      // Clean up old cache entries
      for (const [key, value] of processedJobs.entries()) {
        if (now - value.timestamp > JOB_CACHE_TTL) {
          processedJobs.delete(key);
        }
      }

      return result;
    } catch (error) {
      logger.error('Error processing PR review', {
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        status: 'Failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Clean up
      if (cloneDir) {
        await cleanupRepository(cloneDir);
      }
    }
  }

  /**
   * Extract changed files using GitHub API instead of git operations
   */
  async function extractChangedFilesFromGitHub(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number
  ) {
    try {
      logger.info('Fetching PR files from GitHub API', { owner, repo, prNumber });

      // Get all files changed in the PR with their diffs
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
      });

      logger.info('Retrieved PR files from GitHub', {
        filesCount: files.length,
        fileDetails: files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          hasPatch: !!f.patch,
        })),
      });

      const changedFiles = [];

      for (const file of files) {
        // Skip binary files or files without patches
        if (!file.patch || file.status === ('removed' as any)) {
          logger.debug('Skipping file without patch or removed file', {
            filename: file.filename,
            status: file.status,
            hasPatch: !!file.patch,
          });
          continue;
        }

        try {
          // Get file content from GitHub API
          let content = '';
          try {
            const { data: fileData } = await octokit.rest.repos.getContent({
              owner,
              repo,
              path: file.filename,
              ref: 'HEAD', // Get the latest version
            });

            if ('content' in fileData && fileData.content) {
              content = Buffer.from(fileData.content, 'base64').toString('utf8');
            }
          } catch (error) {
            logger.warn('Could not fetch file content from GitHub API', {
              filename: file.filename,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }

          // Skip binary files
          if (content.includes('\0')) {
            logger.debug('Skipping binary file', { filename: file.filename });
            continue;
          }

          const language = getLanguageFromPath(file.filename);
          const { filteredContent, commentLines } = removeCommentsFromCodeWithTracking(
            content,
            language
          );

          // Parse the GitHub patch to extract diff positions and line mappings
          const diffAnalysis = parseGitHubPatch(file.patch, file.status);

          // Validate that we have valid positions for comments
          if (diffAnalysis.validDiffPositions.size === 0) {
            logger.warn('No valid diff positions found for file, skipping', {
              filename: file.filename,
              status: file.status,
              patchLength: file.patch.length,
            });
            continue;
          }

          // Create annotated content for better AI understanding
          const annotatedContent = createAnnotatedFileContentWithPositions(
            filteredContent,
            diffAnalysis.changedLines,
            diffAnalysis.addedLines,
            commentLines,
            diffAnalysis.lineToPositionMap
          );

          changedFiles.push({
            path: file.filename,
            content: filteredContent,
            originalContent: content,
            annotatedContent,
            patch: file.patch, // GitHub patch format
            language,
            diffAnalysis,
            commentLines,
            isNewFile: file.status === 'added',
            isDeletedFile: file.status === 'removed',
            githubFile: file, // Store the original GitHub file object
          });

          logger.info('Processed file from GitHub API', {
            filename: file.filename,
            status: file.status,
            validPositions: diffAnalysis.validDiffPositions.size,
            changedLines: diffAnalysis.changedLines.size,
          });
        } catch (error) {
          logger.warn('Failed to process file from GitHub API', {
            filename: file.filename,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return changedFiles;
    } catch (error) {
      logger.error('Failed to fetch PR files from GitHub API', {
        owner,
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Parse GitHub patch format to extract diff positions and line mappings
   */
  function parseGitHubPatch(
    patch: string,
    fileStatus: string
  ): {
    changedLines: Set<number>;
    addedLines: Set<number>;
    deletedLines: Set<number>;
    validDiffPositions: Set<number>; // GitHub diff positions (not line numbers)
    lineToPositionMap: Map<number, number>; // Maps line numbers to diff positions
    positionToLineMap: Map<number, number>; // Maps diff positions to line numbers
  } {
    const changedLines = new Set<number>();
    const addedLines = new Set<number>();
    const deletedLines = new Set<number>();
    const validDiffPositions = new Set<number>();
    const lineToPositionMap = new Map<number, number>();
    const positionToLineMap = new Map<number, number>();

    const lines = patch.split('\n');
    let currentNewLine = 0;
    let currentOldLine = 0;
    let diffPosition = 0; // GitHub diff position counter

    for (const line of lines) {
      // Parse hunk headers like @@ -1,4 +1,6 @@
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (hunkMatch) {
        currentOldLine = parseInt(hunkMatch[1]);
        currentNewLine = parseInt(hunkMatch[3]);
        diffPosition++; // Hunk headers count as positions
        continue;
      }

      // Skip patch headers
      if (
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode')
      ) {
        continue;
      }

      // Process diff content lines
      if (line.startsWith('+')) {
        // Added line
        diffPosition++;
        addedLines.add(currentNewLine);
        changedLines.add(currentNewLine);
        validDiffPositions.add(diffPosition);
        lineToPositionMap.set(currentNewLine, diffPosition);
        positionToLineMap.set(diffPosition, currentNewLine);
        currentNewLine++;
      } else if (line.startsWith('-')) {
        // Deleted line (cannot be commented on in GitHub)
        diffPosition++;
        deletedLines.add(currentOldLine);
        currentOldLine++;
        // Note: We don't add deleted lines to validDiffPositions since they can't be commented on
      } else if (line.startsWith(' ')) {
        // Context line (unchanged) - these can be commented on
        diffPosition++;
        validDiffPositions.add(diffPosition);
        lineToPositionMap.set(currentNewLine, diffPosition);
        positionToLineMap.set(diffPosition, currentNewLine);
        currentNewLine++;
        currentOldLine++;
      }
    }

    // For new files, all lines are considered added
    if (fileStatus === 'added') {
      // GitHub treats new files specially - all lines are valid for comments
      // but we need to ensure we have the correct position mapping
    }

    return {
      changedLines,
      addedLines,
      deletedLines,
      validDiffPositions,
      lineToPositionMap,
      positionToLineMap,
    };
  }

  /**
   * Create enhanced file content with line number annotations and position mapping
   */
  function createAnnotatedFileContentWithPositions(
    content: string,
    changedLines: Set<number>,
    addedLines: Set<number>,
    commentLines: Set<number>,
    lineToPositionMap: Map<number, number>
  ): string {
    const lines = content.split('\n');
    const annotatedLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      const line = lines[i];
      const diffPosition = lineToPositionMap.get(lineNumber);

      let annotation = '';
      if (addedLines.has(lineNumber)) {
        annotation = ` // [ADDED LINE - Position: ${diffPosition || 'N/A'}]`;
      } else if (changedLines.has(lineNumber)) {
        annotation = ` // [MODIFIED LINE - Position: ${diffPosition || 'N/A'}]`;
      } else if (commentLines.has(lineNumber)) {
        annotation = ' // [COMMENT LINE - FILTERED]';
      } else if (diffPosition) {
        annotation = ` // [CONTEXT LINE - Position: ${diffPosition}]`;
      }

      annotatedLines.push(`${lineNumber.toString().padStart(4, ' ')}: ${line}${annotation}`);
    }

    return annotatedLines.join('\n');
  }

  /**
   * Generate code review comments using LLM
   */
  async function generateCodeReview(
    changedFiles: any[],
    repository: any
  ): Promise<{ comments: ReviewComment[]; fileValidDiffLines: Map<string, Set<number>> }> {
    const reviewComments: ReviewComment[] = [];
    const fileValidDiffLines = new Map<string, Set<number>>();

    // Filter files based on skip patterns and limits
    const filteredFiles = changedFiles
      .filter((file) => !shouldSkipFile(file.path))
      .filter((file) => file.content.split('\n').length <= config.maxLinesPerFile)
      .slice(0, config.maxFilesPerReview);

    logger.info('Files to review', {
      total: changedFiles.length,
      filtered: filteredFiles.length,
      skipped: changedFiles.length - filteredFiles.length,
    });

    for (const file of filteredFiles) {
      try {
        logger.info('Analyzing file for review', {
          path: file.path,
          validDiffLines: file.diffAnalysis.validDiffLines.size,
        });

        // Store valid diff lines for this file
        fileValidDiffLines.set(file.path, file.diffAnalysis.validDiffLines);

        // Get context for this file using existing embeddings
        const similarCode = await getSimilarCodeContext(file, repository._id);

        // Analyze with LLM
        const analysis = await analyzeCodeWithLLM(file, similarCode);

        // Convert LLM analysis into review comments
        const fileComments = convertAnalysisToComments(
          analysis.issues || [],
          file.path,
          file.diffAnalysis.lineToPositionMap
        );

        // Limit comments per file to avoid overwhelming developers
        const limitedComments = fileComments.slice(0, config.maxCommentsPerFile);

        if (fileComments.length > config.maxCommentsPerFile) {
          logger.info('Truncated comments for file', {
            path: file.path,
            total: fileComments.length,
            kept: limitedComments.length,
          });
        }

        reviewComments.push(...limitedComments);
      } catch (error) {
        logger.error('Error analyzing file', {
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { comments: reviewComments, fileValidDiffLines };
  }

  /**
   * Get similar code context using embeddings
   */
  async function getSimilarCodeContext(file: any, repositoryId: string) {
    try {
      logger.info('Searching for similar code context', {
        path: file.path,
        language: file.language,
        repositoryId: repositoryId.substring(0, 8) + '...',
      });

      // Generate embedding for the changed code
      const embedding = await openai.embeddings.create({
        model: config.embeddingConfig.model,
        input: file.content.substring(0, config.embeddingConfig.maxInputLength),
      });

      // Search for similar code
      const similarCode = await convex.action(api.embeddings.searchSimilarCode, {
        embedding: embedding.data[0].embedding,
        repositoryId: repositoryId as any, // Convert string to Convex ID type
        language: file.language,
        limit: config.embeddingConfig.similarCodeLimit,
      });

      if (similarCode && similarCode.length > 0) {
        logger.info('Found similar code patterns', {
          path: file.path,
          similarCodeCount: similarCode.length,
          patterns: similarCode.map((c: any) => ({
            file: c.filePath,
            type: c.chunkType,
            lines: `${c.startLine}-${c.endLine}`,
          })),
        });
      } else {
        logger.info('No similar code patterns found', {
          path: file.path,
          language: file.language,
          message: 'Repository may not have embeddings indexed yet, or no similar patterns exist',
        });
      }

      return similarCode;
    } catch (error) {
      logger.warn('Failed to get similar code context', {
        path: file.path,
        error: error instanceof Error ? error.message : String(error),
        message: 'This could indicate missing embeddings for the repository',
      });
      return [];
    }
  }

  /**
   * Analyze code using LLM with structured output and robust retry logic
   */
  async function analyzeCodeWithLLM(
    file: any,
    similarCode: any[]
  ): Promise<{
    summary: string;
    issues: Array<{
      line: number;
      severity: 'critical' | 'warning' | 'info';
      category: 'security' | 'bug' | 'performance' | 'maintainability';
      message: string;
      suggestion: string;
      explanation: string;
    }>;
  }> {
    const contextInfo =
      similarCode.length > 0
        ? `\n\nSimilar code patterns in this repository:\n${similarCode
            .map(
              (c) => `File: ${c.filePath} (lines ${c.startLine}-${c.endLine})\nType: ${c.chunkType}`
            )
            .join('\n\n')}`
        : '';
    logger.info('Context info', { contextInfo });
    logger.info('File diff', { fileDiff: file.diff });
    logger.info('File content', { fileContent: file.content });
    logger.info('File path', { filePath: file.path });
    logger.info('File language', { fileLanguage: file.language });
    logger.info('File similar code', { fileSimilarCode: similarCode });

    // Determine change type based on diff content
    let changeType = 'unknown';
    if (file.diff.includes('+++') && file.diff.includes('---')) {
      if (file.diff.includes('new file') || file.diff.includes('index 0000000..0000000')) {
        changeType = 'new file';
      } else if (file.diff.includes('deleted file')) {
        changeType = 'deleted file';
      } else {
        changeType = 'modification';
      }
    } else if (file.diff.includes('@@ -0,0 +1,')) {
      // This is likely our synthetic diff for a new/modified file
      changeType = 'file review (no diff available)';
    }

    // Create context-specific instructions based on change type
    const getChangeTypeInstructions = (changeType: string) => {
      switch (changeType) {
        case 'new file':
          return `**This is a NEW FILE being added to the codebase.** Focus on:
- Overall architecture and design patterns
- Code organization and structure
- Naming conventions and clarity
- Security implications of new functionality
- Performance considerations
- Integration with existing codebase
- Missing error handling or edge cases
- Documentation and comments for complex logic`;

        case 'modification':
          return `**This is a MODIFIED FILE with specific changes.** Focus on:
- Impact of changes on existing functionality
- Potential breaking changes
- Backward compatibility
- Changes in behavior or logic
- New bugs introduced by modifications
- Performance impact of changes`;

        case 'file review (no diff available)':
          return `**Full file review (diff unavailable).** Treat as comprehensive review:
- Review entire file for potential issues
- Focus on overall code quality and best practices
- Look for security vulnerabilities
- Check for performance issues
- Verify error handling and edge cases`;

        default:
          return `**Code review for ${changeType}.** Apply standard review practices.`;
      }
    };

    const prompt = `Your task is to conduct a thorough analysis of a code change, applying the same level of scrutiny as a senior engineer would.

IMPORTANT: 
- Do NOT review or comment on code comments, documentation, or comment blocks. Focus only on the actual executable code logic, structure, and implementation.
- Pay special attention to line numbers. Use the line numbers shown in the annotated content below.
- Focus your review on lines marked as [ADDED LINE] or [MODIFIED LINE] as these are the actual changes.
- Lines marked as [COMMENT LINE - FILTERED] should be ignored.

First, review the annotated file content with line numbers:

<annotated_file_content>
\`\`\`${file.language}
${file.annotatedContent}
\`\`\`
</annotated_file_content>

Original file content for context:

<current_file_content>
\`\`\`${file.language}
${file.content}
\`\`\`
</current_file_content>

Next, review the following file context information:

<file_context>
Path: <file_path>${file.path}</file_path>
Language: <language>${file.language}</language>
Change Type: <change_type>${changeType}</change_type>
</file_context>

${getChangeTypeInstructions(changeType)}

Now, examine the code changes:

<code_diff>
\`\`\`diff
${file.diff}
\`\`\`
</code_diff>

Consider any additional context information provided:

<context_info>
${contextInfo}
</context_info>

Your review should focus on the following priorities, in order of importance:

1. CRITICAL (Must Fix):
   - Security vulnerabilities (e.g., injection, XSS, auth bypass)
   - Data corruption or loss risks
   - Memory leaks or resource exhaustion
   - Race conditions or concurrency issues

2. WARNING (Should Fix):
   - Logic errors that could cause incorrect behavior
   - Performance issues in critical paths
   - Error handling gaps
   - API design inconsistencies

3. INFO (Consider):
   - Code readability improvements
   - Better naming or structure
   - Missing documentation for complex logic

Do not flag:
- Stylistic preferences if the code is readable
- Valid alternative approaches
- TODOs or commented code that's clearly intentional
- Minor spacing or formatting (if consistent)

Analyze the code thoroughly, considering:
${
  changeType === 'new file'
    ? `- Overall design and architecture of the new file
- Adherence to project conventions and patterns
- Security implications of new functionality
- Performance considerations for new code
- Error handling and edge case coverage
- Code organization and maintainability
- Integration points with existing codebase
- Missing documentation or unclear logic`
    : changeType === 'modification'
      ? `- Impact of changes on existing functionality
- Potential bugs or regressions introduced
- Backward compatibility considerations
- Security implications of modifications
- Performance impact of changes
- Code quality improvements or degradations`
      : `- Overall code quality and best practices
- Security vulnerabilities throughout the file
- Performance issues and optimization opportunities
- Error handling and robustness
- Code organization and maintainability
- Adherence to language-specific best practices`
}

You must respond with a JSON object containing:
1. "summary": A brief overall assessment of the code change
2. "issues": An array of issue objects, each containing:
   - "line": The EXACT line number from the annotated content where the issue occurs (look for the number at the start of each line like "  42: code here"). Focus on lines marked as [ADDED LINE] or [MODIFIED LINE]. If you cannot determine the exact line, use the closest line number from the changed lines.
   - "severity": One of "critical", "warning", or "info"
   - "category": One of "security", "bug", "performance", or "maintainability"
   - "message": A clear description of the problem
   - "suggestion": A specific fix or improvement recommendation
   - "explanation": Why this issue matters and its potential impact

CRITICAL: When specifying line numbers, use the exact line numbers shown in the annotated content (the numbers at the beginning of each line). Only comment on lines that are marked as [ADDED LINE] or [MODIFIED LINE].

If no actionable issues are found, return an empty issues array and explain this in the summary.`;

    // Check circuit breaker state
    const now = Date.now();
    logger.info('Circuit breaker status check', {
      filePath: file.path,
      isOpen: circuitBreakerState.isOpen,
      failureCount: circuitBreakerState.failureCount,
      lastFailureTime: circuitBreakerState.lastFailureTime,
      timeSinceLastFailure: now - circuitBreakerState.lastFailureTime,
    });

    if (circuitBreakerState.isOpen) {
      if (now - circuitBreakerState.lastFailureTime > circuitBreakerState.resetTimeoutMs) {
        // Reset circuit breaker
        circuitBreakerState.isOpen = false;
        circuitBreakerState.failureCount = 0;
        logger.info('Circuit breaker reset - attempting API calls again', {
          filePath: file.path,
        });
      } else {
        logger.warn('Circuit breaker is open - skipping API call', {
          filePath: file.path,
          timeUntilReset:
            circuitBreakerState.resetTimeoutMs - (now - circuitBreakerState.lastFailureTime),
        });
        return {
          summary: 'Analysis skipped due to API overload protection. Please try again later.',
          issues: [],
        };
      }
    }

    // Retry configuration for handling API overload
    const MAX_RETRIES = Math.max(1, config.retryConfig.maxRetries); // Ensure at least 1 attempt
    const BASE_DELAY = config.retryConfig.baseDelayMs;
    const MAX_DELAY = config.retryConfig.maxDelayMs;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info('Attempting LLM analysis', {
          attempt,
          maxRetries: MAX_RETRIES,
          filePath: file.path,
        });

        const result = await generateObject({
          model: anthropic('claude-4-sonnet-20250514'),
          schema: z.object({
            summary: z.string(),
            issues: z.array(
              z.object({
                line: z.number(),
                severity: z.enum(['critical', 'warning', 'info']),
                category: z.enum(['security', 'bug', 'performance', 'maintainability']),
                message: z.string(),
                suggestion: z.string(),
                explanation: z.string(),
              })
            ),
          }),
          system: `You are an expert code reviewer with over 10 years of experience in ${file.language} and software engineering best practices. ${
            changeType === 'new file'
              ? `You are reviewing a completely new file being added to the codebase. Pay special attention to overall design, architecture, and how this new code fits into the existing project structure.`
              : changeType === 'modification'
                ? `You are reviewing modifications to an existing file. Focus on the specific changes and their impact on existing functionality.`
                : `You are conducting a comprehensive review of this file. Examine the entire codebase for potential issues.`
          }`,
          prompt: prompt,
          // Add retry configuration to the AI SDK call
          maxRetries: 0, // Disable AI SDK's internal retries since we're handling them manually
        });

        logger.info('LLM analysis successful', {
          attempt,
          filePath: file.path,
          summary: result.object.summary,
          issuesCount: result.object.issues.length,
          issues: result.object.issues.map((issue) => ({
            line: issue.line,
            severity: issue.severity,
            category: issue.category,
            message: issue.message.substring(0, 100) + (issue.message.length > 100 ? '...' : ''),
          })),
        });

        // Reset circuit breaker on success
        circuitBreakerState.failureCount = 0;

        // Validate and correct line numbers if enabled
        const correctedIssues = config.lineNumberValidation.enabled
          ? validateAndCorrectLineNumbers(
              result.object.issues,
              file.content,
              file.diffAnalysis.changedLines,
              file.diffAnalysis.addedLines,
              file.commentLines,
              file.diffAnalysis.validDiffLines
            )
          : result.object.issues;

        return {
          ...result.object,
          issues: correctedIssues,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isOverloadError =
          errorMessage.toLowerCase().includes('overload') ||
          errorMessage.includes('529') ||
          errorMessage.toLowerCase().includes('rate limit');

        logger.warn('LLM analysis attempt failed', {
          attempt,
          maxRetries: MAX_RETRIES,
          error: errorMessage,
          isOverloadError,
          filePath: file.path,
        });

        // If this is the last attempt, log the final error and return fallback
        if (attempt === MAX_RETRIES) {
          // Update circuit breaker on overload errors
          if (isOverloadError) {
            circuitBreakerState.failureCount++;
            circuitBreakerState.lastFailureTime = Date.now();

            if (circuitBreakerState.failureCount >= circuitBreakerState.maxFailures) {
              circuitBreakerState.isOpen = true;
              logger.warn('Circuit breaker opened due to repeated API overload errors', {
                failureCount: circuitBreakerState.failureCount,
                filePath: file.path,
              });
            }
          }

          logger.error('LLM analysis failed after all retries', {
            totalAttempts: MAX_RETRIES,
            finalError: errorMessage,
            filePath: file.path,
            circuitBreakerOpen: circuitBreakerState.isOpen,
          });
          return {
            summary: `Analysis failed after ${MAX_RETRIES} attempts due to API overload. Please try again later.`,
            issues: [],
          };
        }

        // Calculate exponential backoff delay with optional jitter
        const exponentialDelay = Math.min(BASE_DELAY * Math.pow(2, attempt - 1), MAX_DELAY);
        const jitter = config.retryConfig.enableJitter ? Math.random() * 1000 : 0; // Add up to 1 second of random jitter if enabled
        const delay = exponentialDelay + jitter;

        logger.info('Retrying LLM analysis with backoff', {
          attempt,
          nextAttempt: attempt + 1,
          delayMs: Math.round(delay),
          isOverloadError,
        });

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // This should never be reached due to the return in the catch block above
    return { summary: 'Analysis failed unexpectedly', issues: [] };
  }

  /**
   * Convert LLM analysis into review comments with GitHub diff positions
   */
  function convertAnalysisToComments(
    analysis: any[],
    filePath: string,
    lineToPositionMap: Map<number, number>
  ): ReviewComment[] {
    if (!Array.isArray(analysis)) {
      return [];
    }

    return analysis
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const severityEmoji = {
          critical: '🔴',
          warning: '🟡',
          info: '🔵',
        };

        const categoryLabel = {
          security: 'Security',
          bug: 'Bug',
          performance: 'Performance',
          maintainability: 'Code Quality',
        };

        const emoji = severityEmoji[item.severity as keyof typeof severityEmoji] || '⚠️';
        const category = categoryLabel[item.category as keyof typeof categoryLabel] || 'General';

        let body = `${emoji} **${category}**: ${item.message || 'Issue detected'}`;

        if (item.suggestion) {
          body += `\n\n💡 **Suggestion**: ${item.suggestion}`;
        }

        if (item.explanation) {
          body += `\n\n📝 **Why this matters**: ${item.explanation}`;
        }

        // Add AI signature
        body += '\n\n---\n*🤖 Generated by Migaki AI*';

        // Get the GitHub diff position for this line
        const diffPosition = lineToPositionMap.get(item.line || 1);

        if (!diffPosition) {
          logger.warn('No diff position found for line, comment may be skipped', {
            filePath,
            line: item.line,
            availablePositions: Array.from(lineToPositionMap.keys()).slice(0, 5),
          });
        }

        return {
          path: filePath,
          line: item.line || 1,
          position: diffPosition, // GitHub diff position
          body,
          severity: (['info', 'warning', 'critical'].includes(item.severity)
            ? item.severity === 'critical'
              ? 'error'
              : item.severity
            : 'info') as 'info' | 'warning' | 'error',
          category: item.category || 'general',
          suggestion: item.suggestion,
        };
      })
      .filter((comment) => comment.position !== undefined); // Only include comments with valid positions
  }

  /**
   * Validate that all comments have valid line numbers for GitHub PR review
   */
  function validateCommentsForGitHub(
    comments: ReviewComment[],
    fileValidDiffLines?: Map<string, Set<number>>
  ): {
    validComments: ReviewComment[];
    invalidComments: Array<{ comment: ReviewComment; reason: string }>;
  } {
    const validComments: ReviewComment[] = [];
    const invalidComments: Array<{ comment: ReviewComment; reason: string }> = [];

    for (const comment of comments) {
      // Basic validation
      if (!comment.path || typeof comment.path !== 'string') {
        invalidComments.push({ comment, reason: 'Missing or invalid path' });
        continue;
      }

      if (!comment.line || typeof comment.line !== 'number' || comment.line < 1) {
        invalidComments.push({ comment, reason: 'Missing or invalid line number' });
        continue;
      }

      if (!comment.body || typeof comment.body !== 'string' || comment.body.trim() === '') {
        invalidComments.push({ comment, reason: 'Missing or empty body' });
        continue;
      }

      // Validate against diff lines if available
      if (fileValidDiffLines) {
        const validLines = fileValidDiffLines.get(comment.path);
        if (validLines && !validLines.has(comment.line)) {
          invalidComments.push({
            comment,
            reason: `Line ${comment.line} is not part of the diff for file ${comment.path}`,
          });
          continue;
        }
      }

      validComments.push(comment);
    }

    return { validComments, invalidComments };
  }

  /**
   * Post review comments to GitHub using GitHub App authentication
   * Uses the Pull Request Review API for efficient batch posting
   */
  async function postCommentsToGitHub(
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
    comments: ReviewComment[],
    commitSha: string,
    fileValidDiffLines?: Map<string, Set<number>>
  ) {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_PRIVATE_KEY;

    if (!appId || !privateKey) {
      logger.warn('GitHub App credentials not configured, logging comments instead');
      return logCommentsInstead(comments, { installationId, owner, repo, prNumber, commitSha });
    }

    // Declare filteredComments outside try block for broader scope
    let filteredComments = comments;

    try {
      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId,
          privateKey,
          installationId,
        },
      });

      if (comments.length === 0) {
        logger.info('No comments to post');
        return [];
      }

      // Fetch existing comments to avoid duplicates
      const existingComments = await fetchExistingPRComments(octokit, owner, repo, prNumber);

      // Filter out duplicate comments
      filteredComments = filterDuplicateComments(comments, existingComments);

      if (filteredComments.length === 0) {
        logger.info('All comments were duplicates, skipping posting');
        return [];
      }

      // Validate comments before posting
      const { validComments, invalidComments } = validateCommentsForGitHub(
        filteredComments,
        fileValidDiffLines
      );

      if (invalidComments.length > 0) {
        logger.warn('Found invalid comments that will be skipped', {
          invalidCount: invalidComments.length,
          totalCount: filteredComments.length,
          invalidComments: invalidComments.map((ic) => ({
            path: ic.comment.path,
            line: ic.comment.line,
            reason: ic.reason,
          })),
        });
      }

      if (validComments.length === 0) {
        logger.warn('No valid comments to post after validation');
        return [];
      }

      // Use the validated comments
      filteredComments = validComments;

      // Use GitHub's Pull Request Review API for batch posting
      // This is much more efficient and avoids rate limits
      const reviewComments = filteredComments.map((comment) => ({
        path: comment.path,
        position: comment.position, // Use diff position instead of line number
        body: comment.body,
      }));

      const summary = generateReviewSummary(filteredComments);
      const criticalCount = filteredComments.filter((c) => c.severity === 'error').length;

      // Determine review event based on severity
      const event = criticalCount > 0 ? 'REQUEST_CHANGES' : 'COMMENT';

      // Log detailed information about the review being posted
      logger.info('Posting PR review with comments', {
        owner,
        repo,
        prNumber,
        commitSha: commitSha.substring(0, 7),
        event,
        commentsCount: reviewComments.length,
        criticalCount,
        commentDetails: reviewComments.map((c) => ({
          path: c.path,
          position: c.position,
          bodyLength: c.body.length,
        })),
      });

      try {
        const reviewResponse = await octokit.pulls.createReview({
          owner,
          repo,
          pull_number: prNumber,
          commit_id: commitSha,
          body: summary,
          event: event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
          comments: reviewComments,
        });

        logger.info('Posted complete PR review', {
          reviewId: reviewResponse.data.id,
          commentsCount: filteredComments.length,
          event,
          criticalIssues: criticalCount,
        });

        return [reviewResponse.data];
      } catch (error) {
        logger.error('Failed to post batch review, falling back to individual comments', {
          error: error instanceof Error ? error.message : String(error),
        });

        // Fallback: Post individual comments with rate limiting
        return await postIndividualCommentsWithRateLimit(
          octokit,
          owner,
          repo,
          prNumber,
          commitSha,
          filteredComments
        );
      }
    } catch (error) {
      logger.error('Failed to authenticate with GitHub', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fall back to logging
      return logCommentsInstead(filteredComments, {
        installationId,
        owner,
        repo,
        prNumber,
        commitSha,
      });
    }
  }

  /**
   * Fallback method to post individual comments with rate limiting
   */
  async function postIndividualCommentsWithRateLimit(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
    comments: ReviewComment[]
  ) {
    const postedComments = [];
    const RATE_LIMIT_DELAY = 1000; // 1 second between requests
    const MAX_RETRIES = 3;

    for (let i = 0; i < comments.length; i++) {
      const comment = comments[i];
      let retries = 0;

      while (retries < MAX_RETRIES) {
        try {
          // Add delay between requests to avoid rate limiting
          if (i > 0) {
            await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
          }

          const response = await octokit.pulls.createReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            commit_id: commitSha,
            path: comment.path,
            position: comment.position,
            body: comment.body,
          });

          postedComments.push(response.data);
          logger.info('Posted individual review comment', {
            path: comment.path,
            position: comment.position,
            commentId: response.data.id,
            attempt: retries + 1,
          });
          break; // Success, move to next comment
        } catch (error) {
          retries++;
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (errorMessage.includes('rate limit') && retries < MAX_RETRIES) {
            const backoffDelay = RATE_LIMIT_DELAY * Math.pow(2, retries); // Exponential backoff
            logger.warn('Rate limit hit, retrying with backoff', {
              path: comment.path,
              position: comment.position,
              attempt: retries,
              delayMs: backoffDelay,
            });
            await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          } else {
            logger.error('Failed to post individual comment after retries', {
              path: comment.path,
              position: comment.position,
              error: errorMessage,
              attempts: retries,
            });
            break; // Give up on this comment
          }
        }
      }
    }

    // Post summary comment separately
    if (comments.length > 0) {
      const summary = generateReviewSummary(comments);
      try {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
        const summaryResponse = await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: summary,
        });

        logger.info('Posted review summary', {
          commentId: summaryResponse.data.id,
          commentsCount: comments.length,
        });
      } catch (error) {
        logger.warn('Failed to post summary comment', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return postedComments;
  }

  /**
   * Fallback to log comments when GitHub API is not available
   */
  function logCommentsInstead(
    comments: ReviewComment[],
    context: {
      installationId: number;
      owner: string;
      repo: string;
      prNumber: number;
      commitSha: string;
    }
  ) {
    logger.info('Logging review comments instead of posting to GitHub', {
      ...context,
      commitSha: context.commitSha.substring(0, 7),
      commentsCount: comments.length,
    });

    const postedComments = [];

    for (const comment of comments) {
      logger.info('Review comment', {
        path: comment.path,
        line: comment.line,
        position: comment.position,
        severity: comment.severity,
        category: comment.category,
        body: comment.body.substring(0, 200) + (comment.body.length > 200 ? '...' : ''),
      });

      postedComments.push({
        id: Math.random().toString(),
        path: comment.path,
        line: comment.line,
        position: comment.position,
      });
    }

    if (comments.length > 0) {
      const summary = generateReviewSummary(comments);
      logger.info('Review summary', { summary });
    }

    return postedComments;
  }

  /**
   * Generate a review summary
   */
  function generateReviewSummary(comments: ReviewComment[]): string {
    const criticalCount = comments.filter((c) => c.severity === 'error').length;
    const warningCount = comments.filter((c) => c.severity === 'warning').length;
    const infoCount = comments.filter((c) => c.severity === 'info').length;

    let summary = `## 🔍 Code Review Summary\n\n`;
    summary += `I've analyzed your pull request and found ${comments.length} item(s) for your consideration:\n\n`;

    if (criticalCount > 0) {
      summary += `- 🚨 **${criticalCount} Critical issue(s)** that should be addressed\n`;
    }
    if (warningCount > 0) {
      summary += `- ⚠️ **${warningCount} Warning(s)** worth reviewing\n`;
    }
    if (infoCount > 0) {
      summary += `- ℹ️ **${infoCount} Suggestion(s)** for improvement\n`;
    }

    summary += `\nPlease review the inline comments for details. Each comment includes specific suggestions for improvement.`;

    if (criticalCount === 0) {
      summary += `\n\n✅ No critical issues detected. Great work!`;
    }

    return summary;
  }

  /**
   * Get language from file path
   */
  function getLanguageFromPath(filePath: string): string {
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

  /**
   * Clean up repository directory
   */
  async function cleanupRepository(cloneDir: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      await fs.rm(cloneDir, { recursive: true, force: true });
      logger.info('Repository cleanup successful', { cloneDir });
    } catch (error) {
      logger.error('Repository cleanup failed', {
        cloneDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get current circuit breaker status for monitoring
   */
  function getCircuitBreakerStatus() {
    return {
      isOpen: circuitBreakerState.isOpen,
      failureCount: circuitBreakerState.failureCount,
      lastFailureTime: circuitBreakerState.lastFailureTime,
      timeUntilReset: circuitBreakerState.isOpen
        ? Math.max(
            0,
            circuitBreakerState.resetTimeoutMs - (Date.now() - circuitBreakerState.lastFailureTime)
          )
        : 0,
    };
  }

  return {
    processPullRequestReview,
    getCircuitBreakerStatus,
  };
}
