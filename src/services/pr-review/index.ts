import { ConvexHttpClient } from 'convex/browser';
import OpenAI from 'openai';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createGitService } from '../git-service.js';
import { api } from '../../convex/api.js';
import { logger } from '../../utils/logger.js';
import { PullRequestReviewJob, ReviewComment, PullRequestReviewResult } from '../../types.js';

// Import all the modular components
import { ReviewConfig, ProcessedFile, CircuitBreakerStatus } from './types.js';
import { DEFAULT_CONFIG, shouldSkipFile } from './config.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { cleanupRepository } from './file-processor.js';
import { validateAndCorrectLineNumbers } from './diff-analyzer.js';
import { getSimilarCodeContext, analyzeCodeWithLLM } from './llm-analyzer.js';
import { convertAnalysisToComments } from './comment-manager.js';
import { extractChangedFilesFromGitHub, postCommentsToGitHub } from './github-integration.js';

/**
 * Pull Request Review Service
 *
 * This service handles automated code review for pull requests using AI.
 *
 * The service has been refactored into focused modules for better maintainability:
 * - types.ts: Shared interfaces and types
 * - config.ts: Configuration and utility functions
 * - circuit-breaker.ts: Retry logic and API overload protection
 * - file-processor.ts: File content processing and comment removal
 * - diff-analyzer.ts: Git diff parsing and line number validation
 * - llm-analyzer.ts: AI-powered code analysis
 * - comment-manager.ts: Comment validation and deduplication
 * - github-integration.ts: GitHub API interactions
 *
 * Key features:
 * - Accurate line number mapping for GitHub PR comments
 * - Circuit breaker pattern for API resilience
 * - Comment deduplication and validation
 * - Structured LLM analysis with retry logic
 * - Comprehensive file processing and diff analysis
 */

export function createPullRequestReviewService(deps: {
  convex: ConvexHttpClient;
  openai: OpenAI;
  config?: Partial<ReviewConfig>;
}) {
  const { convex, openai, config: userConfig } = deps;
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  // Circuit breaker for handling API overload
  const circuitBreaker = new CircuitBreaker();

  // Job deduplication cache to prevent processing the same job multiple times
  const processedJobs = new Map<string, { timestamp: number; result: any }>();
  const JOB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
      await checkEmbeddingAvailability(repository);

      // Step 2: Create review record in database
      const reviewId = await convex.mutation(api.github.createPullRequestReview, {
        repositoryId: repository._id,
        prNumber,
        prTitle,
        prUrl,
        commitSha,
      });

      // Step 3: Clone repository and get PR diff (for diff summary only)
      cloneDir = `/tmp/pr-review-${repo}-${prNumber}-${Date.now()}`;
      const gitService = createGitService({
        githubToken: repository.accessToken,
      });

      const repoGit = await gitService.cloneRepository(repository.cloneUrl, cloneDir);
      await gitService.checkout(repoGit, commitSha);

      // Get the diff between base and head for logging
      const diffSummary = await gitService.getDiffSummary(repoGit, baseSha, commitSha);
      logger.info('Got PR diff', {
        filesChanged: diffSummary.files.length,
        insertions: diffSummary.insertions,
        deletions: diffSummary.deletions,
      });

      // Step 4: Extract changed files using GitHub API
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
        prNumber,
        commitSha
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
        totalFiles: changedFiles.length,
        filteredFiles: changedFiles.filter(
          (file) => !shouldSkipFile(file.path, config.skipPatterns)
        ).length,
        skippedFiles:
          changedFiles.length -
          changedFiles.filter((file) => !shouldSkipFile(file.path, config.skipPatterns)).length,
      });

      const { comments: reviewComments, fileValidDiffLines } = await generateCodeReview(
        changedFiles,
        repository
      );

      logger.info('Code review generation completed', {
        totalFiles: changedFiles.length,
        successfulAnalyses: reviewComments.length,
        failedAnalyses: 0,
        totalComments: reviewComments.length,
        circuitBreakerStatus: circuitBreaker.getStatus(),
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
   * Check embedding availability for the repository
   */
  async function checkEmbeddingAvailability(repository: any): Promise<void> {
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
  }

  /**
   * Generate code review comments using LLM
   */
  async function generateCodeReview(
    changedFiles: ProcessedFile[],
    repository: any
  ): Promise<{ comments: ReviewComment[]; fileValidDiffLines: Map<string, Set<number>> }> {
    const reviewComments: ReviewComment[] = [];
    const fileValidDiffLines = new Map<string, Set<number>>();

    // Filter files that should be skipped
    const filteredFiles = changedFiles.filter(
      (file) => !shouldSkipFile(file.path, config.skipPatterns)
    );

    logger.info('Starting code review generation', {
      totalFiles: changedFiles.length,
      filteredFiles: filteredFiles.length,
      skippedFiles: changedFiles.length - filteredFiles.length,
    });

    let successfulAnalyses = 0;
    let failedAnalyses = 0;

    for (const file of filteredFiles) {
      try {
        logger.info('Analyzing file for review', {
          path: file.path,
          validDiffLines: file.diffAnalysis?.validDiffLines?.size || 0,
        });

        // Store valid diff lines for this file
        const validDiffLines = file.diffAnalysis?.validDiffLines || new Set<number>();
        fileValidDiffLines.set(file.path, validDiffLines);

        // Get context for this file using existing embeddings
        const similarCode = await getSimilarCodeContext(
          file,
          repository._id,
          openai,
          convex,
          config.embeddingConfig
        );

        // Analyze with LLM
        const analysis = await analyzeCodeWithLLM(file, similarCode, config, circuitBreaker);

        // Check if analysis failed due to rate limits
        if (
          analysis.summary.includes('Analysis failed') ||
          analysis.summary.includes('API overload')
        ) {
          failedAnalyses++;
          logger.warn('File analysis failed due to rate limits, skipping', {
            path: file.path,
            summary: analysis.summary,
          });
          continue; // Skip this file but continue with others
        }

        // Validate and correct line numbers if enabled
        const correctedIssues = config.lineNumberValidation.enabled
          ? validateAndCorrectLineNumbers(
              analysis.issues || [],
              file.content,
              file.diffAnalysis.changedLines,
              file.diffAnalysis.addedLines,
              file.commentLines,
              file.diffAnalysis.validDiffLines,
              config.lineNumberValidation
            )
          : analysis.issues;

        // Convert LLM analysis into review comments
        const fileComments = convertAnalysisToComments(
          correctedIssues || [],
          file.path,
          file.diffAnalysis?.lineToPositionMap || new Map<number, number>()
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
        successfulAnalyses++;
      } catch (error) {
        failedAnalyses++;
        logger.error('Error analyzing file', {
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other files instead of failing the entire review
      }
    }

    logger.info('Code review generation completed', {
      totalFiles: filteredFiles.length,
      successfulAnalyses,
      failedAnalyses,
      totalComments: reviewComments.length,
      circuitBreakerStatus: circuitBreaker.getStatus(),
    });

    // Add a summary comment if some files failed due to rate limits
    if (failedAnalyses > 0) {
      logger.info('Some files failed analysis due to rate limits', {
        failedCount: failedAnalyses,
        successfulCount: successfulAnalyses,
      });
    }

    return { comments: reviewComments, fileValidDiffLines };
  }

  /**
   * Get current circuit breaker status for monitoring
   */
  function getCircuitBreakerStatus(): CircuitBreakerStatus {
    return circuitBreaker.getStatus();
  }

  return {
    processPullRequestReview,
    getCircuitBreakerStatus,
  };
}
