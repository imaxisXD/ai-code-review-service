import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/api.js';
import { createGitService } from './git-service.js';
import { createTreeSitterService } from './tree-sitter-service.js';
import { determineChanges } from '../helper/file-change.js';
import { logger } from '../utils/logger.js';
import { cleanupRepository, updateIndexingStatus } from '../helper/cleanup.js';
import { processFiles } from '../helper/file-functions.js';
import { IndexingJob, PullRequestReviewJob, Job } from '../types.js';
import OpenAI from 'openai';
import { createPullRequestReviewService } from './pr-review-service.js';

/**
 * Processes indexing jobs from Pub/Sub
 */
export function createJobProcessor(deps: { convex: ConvexHttpClient; openai: OpenAI }) {
  const { convex, openai } = deps;

  // Initialize TreeSitter service
  const treeSitterService = createTreeSitterService();

  // Initialize PR review service
  const prReviewService = createPullRequestReviewService({ convex, openai });

  /**
   * Processes any type of job
   */
  async function processJob(job: Job): Promise<void> {
    if (job.jobType === 'pr_review') {
      return await processPullRequestReview(job as PullRequestReviewJob);
    } else {
      return await processIndexingJob(job as IndexingJob);
    }
  }

  /**
   * Processes a pull request review job
   */
  async function processPullRequestReview(job: PullRequestReviewJob): Promise<void> {
    try {
      logger.info('Processing PR review job', {
        repoId: job.repoId,
        prNumber: job.prNumber,
        owner: job.owner,
        repo: job.repo,
      });

      const result = await prReviewService.processPullRequestReview(job);

      if (result.status === 'Success') {
        logger.info('PR review completed successfully', {
          reviewId: result.reviewId,
          commentsPosted: result.commentsPosted,
        });
      } else {
        logger.error('PR review failed', { error: result.error });
      }
    } catch (error) {
      logger.error('Error processing PR review job', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Processes an indexing job
   */
  async function processIndexingJob(job: IndexingJob): Promise<void> {
    const { repoId, jobType, userId } = job;
    let cloneDir = '';

    try {
      logger.info('Processing indexing job', { repoId, userId, jobType });

      // Step 1: Get Repository Details and Clone
      const repo = await convex.query(api.repositories.getRepositoryWithStringId, {
        repositoryId: repoId,
        userId: userId,
      });

      cloneDir = `/tmp/repo-${repo.repositoryName}-${repo._id}-${Date.now()}`;
      const effectiveGithubToken = repo.accessToken;
      const cloneUrl = repo.cloneUrl;

      // Update status to Processing
      await updateIndexingStatus(convex, repoId, 'pending');

      // Clone repository
      logger.info(`Cloning repository`, { cloneUrl, cloneDir });
      const cloneOptions = jobType === 'initial' ? ['--depth=1'] : [];

      // Initialize git service with the effective token
      const gitService = createGitService({
        githubToken: effectiveGithubToken,
      });

      const repoGit = await gitService.cloneRepository(cloneUrl, cloneDir, cloneOptions);
      const headCommit = await gitService.getHeadCommit(repoGit);
      logger.info('Repository cloned', { headCommit });

      // For incremental indexing, get the previous commit SHA
      let beforeSha = '';
      if (jobType !== 'initial') {
        try {
          // Get the previous commit SHA using git
          beforeSha = await repoGit.raw(['rev-parse', 'HEAD~1']);
          beforeSha = beforeSha.trim(); // Remove any whitespace
          logger.info('Previous commit identified', { beforeSha });
        } catch (error) {
          logger.warn('Failed to get previous commit, treating as initial indexing', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Process file changes
      logger.info('Determining changes', {
        jobType,
        cloneDir,
        hasPreviousSha: !!beforeSha,
        headCommit,
      });

      // Determine changes
      const changes = await determineChanges(
        repoGit,
        cloneDir,
        jobType,
        beforeSha || '',
        headCommit || '',
        gitService
      );

      // Extract results
      const filesToProcess = changes.filesToProcess;
      const filesToDelete = changes.filesToDelete;

      logger.info('Files to process', {
        count: filesToProcess.length,
        deleteCount: filesToDelete.length,
      });

      // Process deletions
      if (filesToDelete.length > 0) {
        logger.info(`Deleting embeddings`, { count: filesToDelete.length });
        try {
          const result = await convex.mutation(api.embeddings.deleteEmbeddingsByPathBatch, {
            repositoryId: repoId,
            filePaths: filesToDelete,
          });
          logger.info(`Deleted embeddings`, { result });
        } catch (error) {
          logger.error(`Error deleting embeddings`, { error });
        }
      }

      // Process files
      const processedFiles = await processFiles(
        cloneDir,
        filesToProcess,
        repoId,
        headCommit || '',
        openai,
        treeSitterService,
        convex
      );

      // Update last indexed SHA
      logger.info(`Updating last indexed commit`, {
        repoId,
        commitSha: headCommit,
      });
      await convex.mutation(api.repositories.updateLastIndexedCommit, {
        repositoryId: repoId,
        commitSha: headCommit,
        status: 'indexed',
      });

      const processingResult = {
        status: 'Success',
        filesProcessed: processedFiles.length,
        filesDeleted: filesToDelete.length,
        commitSha: headCommit,
      };
      logger.info('Indexing job completed', { processingResult });
    } catch (error) {
      await updateIndexingStatus(
        convex,
        repoId,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      logger.error('Error processing job', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Always clean up the repository directory
      if (cloneDir) {
        await cleanupRepository(cloneDir);
      }
    }
  }
  return {
    processJob,
  };
}
