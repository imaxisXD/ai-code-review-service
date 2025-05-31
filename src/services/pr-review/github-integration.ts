import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { logger } from '../../utils/logger.js';
import { ReviewComment } from '../../types.js';
import { ProcessedFile, ExistingComment } from './types.js';
import { getLanguageFromPath } from './config.js';
import {
  removeCommentsFromCodeWithTracking,
  createAnnotatedFileContentWithPositions,
  reconstructContentFromPatch,
} from './file-processor.js';
import { parseGitHubPatch } from './diff-analyzer.js';
import {
  filterDuplicateComments,
  validateCommentsForGitHub,
  generateReviewSummary,
} from './comment-manager.js';
import { RATE_LIMIT_DELAY, MAX_RETRIES } from './config.js';

/**
 * GitHub Integration Module
 *
 * Handles all GitHub API interactions including file fetching,
 * comment posting, and PR management.
 */

/**
 * Extract changed files using GitHub API instead of git operations
 */
export async function extractChangedFilesFromGitHub(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string
): Promise<ProcessedFile[]> {
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

    const changedFiles: ProcessedFile[] = [];

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
        let contentFetchFailed = false;
        try {
          const { data: fileData } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: file.filename,
            ref: commitSha, // Get the version from the specific commit
          });

          if ('content' in fileData && fileData.content) {
            content = Buffer.from(fileData.content, 'base64').toString('utf8');
          }
        } catch (error) {
          contentFetchFailed = true;
          logger.warn(
            'Could not fetch file content from GitHub API, will try to reconstruct from patch',
            {
              filename: file.filename,
              error: error instanceof Error ? error.message : String(error),
            }
          );

          // Try to reconstruct content from patch for new files
          if (file.status === 'added' && file.patch) {
            content = reconstructContentFromPatch(file.patch);
            if (content) {
              logger.info('Successfully reconstructed content from patch', {
                filename: file.filename,
                contentLength: content.length,
              });
              contentFetchFailed = false;
            }
          }

          if (contentFetchFailed) {
            logger.warn('Skipping file due to content fetch failure', {
              filename: file.filename,
            });
            continue;
          }
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
          diff: file.patch, // Add diff property for compatibility
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
 * Fetch existing comments on a PR to avoid duplicates
 */
export async function fetchExistingPRComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ExistingComment[]> {
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

    const existingComments: ExistingComment[] = [];

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
 * Post review comments to GitHub using GitHub App authentication
 * Uses the Pull Request Review API for efficient batch posting
 */
export async function postCommentsToGitHub(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  comments: ReviewComment[],
  commitSha: string,
  fileValidDiffLines?: Map<string, Set<number>>
): Promise<any[]> {
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
): Promise<any[]> {
  const postedComments = [];

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
): any[] {
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
