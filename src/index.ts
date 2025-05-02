import { Hono } from 'hono';
import { createAuthMiddleware } from './middleware/auth.js';
import { createLoggerMiddleware } from './middleware/logger.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { serve } from '@hono/node-server';
import OpenAI from 'openai';
import { IndexingJob } from './types.js';
import { ConvexHttpClient } from 'convex/browser';
import { api } from './convex/api.js';
import { createGitService } from './services/git-service.js';
import { createTreeSitterService } from './services/tree-sitter-service.js';
import { determineChanges } from './helper/file-change.js';
import { logger } from './utils/logger.js';
import { cleanupRepository, updateIndexingStatus } from './helper/cleanup.js';
import { processFiles } from './helper/file-functions.js';

// --- Environment Variable Caching ---
// Read environment variables once at startup
const { OPENAI_API_KEY, CONVEX_URL, SERVICE_SECRET_KEY, PORT, QSTASH_TOKEN } = process.env;

// Validate required environment variables
if (!OPENAI_API_KEY) {
  throw new Error('Missing required environment variable: OPENAI_API_KEY');
}
if (!CONVEX_URL) {
  throw new Error('Missing required environment variable: CONVEX_URL');
}
if (!SERVICE_SECRET_KEY) {
  throw new Error('Missing required environment variable: SERVICE_SECRET_KEY');
}
if (!QSTASH_TOKEN) {
  throw new Error('Missing required environment variable: QSTASH_TOKEN');
}

// Initialize Convex client
const convex = new ConvexHttpClient(CONVEX_URL);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Initialize TreeSitter service
const treeSitterService = createTreeSitterService();

// Create application - Removed Env from Variables
const app = new Hono<{ Variables: { requestBody?: IndexingJob } }>();

// Add error handling middleware
app.use('*', createErrorHandler());

// Add logger middleware
app.use('*', createLoggerMiddleware());

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
  });
});

// Create a nested router for indexing - Removed Env from Variables
const indexingRouter = new Hono<{ Variables: { requestBody?: IndexingJob } }>();

// Apply auth middleware to protected routes - Pass cached secret key
indexingRouter.post('/', createAuthMiddleware(SERVICE_SECRET_KEY), async (c) => {
  const jobData = c.get('requestBody');
  if (!jobData) {
    return c.json(
      {
        status: 'Failed',
        error: 'Missing request body',
      },
      400
    );
  }

  logger.info('Processing indexing job', {
    repoId: jobData.repoId,
    jobType: jobData.jobType,
  });

  const { repoId, userId, jobType } = jobData;

  if (!repoId) {
    logger.error('Missing required fields', { repoId });
    return c.json(
      {
        status: 'Failed',
        error: 'Missing required fields: repoId is required',
      },
      400
    );
  }

  // Get repository details
  const repo = await convex.query(api.repositories.getRepositoryWithStringId, {
    repositoryId: repoId,
    userId: userId,
  });

  const cloneDir = `/tmp/repo-${repo.repositoryName}-${repo._id}-${Date.now()}`;
  const effectiveGithubToken = repo.accessToken;
  let processingResult = null;
  let headCommit = null;
  let beforeSha;
  const cloneUrl = repo.cloneUrl;

  try {
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

    // Get head commit
    headCommit = await gitService.getHeadCommit(repoGit);
    logger.info('Repository cloned', { headCommit });

    // For incremental indexing, get the previous commit SHA
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

    // Determine files to process and delete
    const { filesToProcess, filesToDelete } = await determineChanges(
      repoGit,
      cloneDir,
      jobType,
      beforeSha || '',
      headCommit || '',
      gitService
    );

    // Process deletions
    if (filesToDelete.length > 0) {
      logger.info(`Deleting embeddings`, { count: filesToDelete.length });
      // await convex.mutation(api.embeddings.deleteEmbeddingsByPathBatch, {
      //   repositoryId: repoId,
      //   filePaths: filesToDelete,
      // });
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

    processingResult = {
      status: 'Success',
      filesProcessed: processedFiles.length,
      filesDeleted: filesToDelete.length,
      commitSha: headCommit,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Processing failed', { error: errorMessage });

    processingResult = {
      status: 'Failed',
      error: errorMessage,
    };

    // Update status to Failed
    await updateIndexingStatus(convex, repoId, 'failed', errorMessage);
  } finally {
    // Clean up cloned repository
    await cleanupRepository(cloneDir);
  }

  // Send response
  if (processingResult?.status === 'Success') {
    return c.json(processingResult, 200);
  } else {
    return c.json(processingResult || { status: 'Failed', error: 'Unknown error' }, 500);
  }
});

// Mount the indexing router
app.route('/', indexingRouter);

// Method not allowed for other methods on root path
app.all('/', (c) => c.text('Method Not Allowed', 405));

serve({
  fetch: app.fetch,
  port: Number(PORT) || 8080,
});
