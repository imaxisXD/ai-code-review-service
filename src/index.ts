import * as functions from '@google-cloud/functions-framework';
import path from 'path';
import fs from 'fs/promises';
import { ConvexHttpClient } from 'convex/browser';
import { GitService } from './services/git-service';
import { EmbeddingService } from './services/embedding-service';
import { FileProcessorService } from './services/file-processor-service';
import { Logger } from './utils/logger';

// Types
import { IndexingJob, ProcessingResult, EmbeddingChunk, IndexingStatus } from './types';
import { api } from './convex/api';

// Configuration
const CONVEX_URL = process.env.CONVEX_URL as string;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Initialize logger
const logger = new Logger({
  service: 'indexing-worker',
  level: LOG_LEVEL,
});

// Initialize services
const convex = new ConvexHttpClient(CONVEX_URL);
const embeddingService = new EmbeddingService({ logger });
const fileProcessor = new FileProcessorService({ logger });

/**
 * Main HTTP Handler for repository indexing
 */
exports.httpHandler = async (req: functions.Request, res: functions.Response) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // Parse job data
  const jobData = req.body as IndexingJob;
  logger.info('Received indexing job', {
    repoId: jobData.repoId,
    jobType: jobData.jobType,
  });

  const { repoId, userId, serviceSecretKey, jobType } = jobData;

  if (serviceSecretKey !== process.env.SERVICE_SECRET_KEY) {
    logger.error('Invalid service secret key');
    return res.status(401).json({
      status: 'Failed',
      error: 'Invalid service secret key',
    });
  }

  if (!repoId) {
    logger.error('Missing required fields', { repoId });
    return res.status(400).json({
      status: 'Failed',
      error: 'Missing required fields: repoId is required',
    });
  }

  // Get repository details
  const repo = await convex.query(api.repositories.getRepositoryWithStringId, {
    repositoryId: repoId,
    userId: userId,
  });

  const cloneDir = `/tmp/repo-${repo.repositoryName}-${repo._id}-${Date.now()}`;

  const effectiveGithubToken = repo.accessToken;

  let processingResult: ProcessingResult | null = null;
  let headCommit: string | null = null;
  let beforeSha: string | undefined;
  const cloneUrl = repo.cloneUrl;
  try {
    // Update status to Processing
    await updateIndexingStatus(repoId, 'pending');

    // Clone repository
    logger.info(`Cloning repository`, { cloneUrl, cloneDir });
    const cloneOptions = jobType === 'initial' ? ['--depth=1'] : [];

    // Initialize git service with the effective token
    const gitServiceInstance = new GitService({
      logger,
      githubToken: effectiveGithubToken,
    });

    const repoGit = await gitServiceInstance.cloneRepository(cloneUrl, cloneDir, cloneOptions);

    // Get head commit
    headCommit = await gitServiceInstance.getHeadCommit(repoGit);
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
      beforeSha,
      headCommit || '',
      gitServiceInstance
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
    const processedFiles = await processFiles(cloneDir, filesToProcess, repoId, headCommit || '');

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
    await updateIndexingStatus(repoId, 'failed', errorMessage);
  } finally {
    // Clean up cloned repository
    await cleanupRepository(cloneDir);
  }

  // Send response
  if (processingResult?.status === 'Success') {
    res.status(200).json(processingResult);
  } else {
    res.status(500).json(processingResult || { status: 'Failed', error: 'Unknown error' });
  }
};

/**
 * Determine which files to process and delete based on job type
 */
async function determineChanges(
  repoGit: ReturnType<typeof GitService.prototype.getSimpleGit>,
  cloneDir: string,
  jobType: string,
  beforeSha: string | undefined,
  endSha: string,
  gitServiceInstance: GitService
): Promise<{ filesToProcess: string[]; filesToDelete: string[] }> {
  let filesToProcess: string[] = [];
  let filesToDelete: string[] = [];

  if (jobType === 'initial') {
    logger.info('Initial indexing - getting all files');
    const allFiles = await fileProcessor.getAllFilesRecursive(cloneDir);
    filesToProcess = allFiles.filter((file: string) => fileProcessor.shouldProcessFile(file));
  } else if (beforeSha && endSha && beforeSha !== endSha) {
    logger.info(`Incremental indexing`, { fromSha: beforeSha, toSha: endSha });
    const diffSummary = await gitServiceInstance.getDiffSummary(repoGit, beforeSha, endSha);

    filesToDelete = diffSummary.files
      .map(f => (typeof f.file === 'string' ? f.file : undefined))
      .filter((file): file is string => file !== undefined);

    filesToProcess = diffSummary.files
      .map(f => (typeof f.file === 'string' ? f.file : undefined))
      .filter((file): file is string => file !== undefined)
      .map(relPath => path.join(cloneDir, relPath));
  } else {
    logger.info('No changes detected or missing SHAs for incremental indexing');
  }

  logger.info('Changes determined', {
    filesToProcess: filesToProcess.length,
    filesToDelete: filesToDelete.length,
  });

  return { filesToProcess, filesToDelete };
}

/**
 * Process files and generate embeddings
 */
async function processFiles(
  cloneDir: string,
  filesToProcess: string[],
  repoId: string,
  commitSha: string
): Promise<string[]> {
  const processedFiles: string[] = [];

  logger.info(`Processing files`, { count: filesToProcess.length });

  // Process in batches to avoid memory issues
  const BATCH_SIZE = 20;
  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async fullFilePath => {
        try {
          // Check if file exists and is not a directory
          const stats = await fs.stat(fullFilePath).catch(() => null);
          if (!stats || !stats.isFile()) return;

          const relativePath = path.relative(cloneDir, fullFilePath);
          logger.info(`Processing file`, { path: relativePath });

          // Parse file into chunks
          const chunks = await fileProcessor.parseAndChunkFile(fullFilePath);

          // Process each chunk
          for (const chunk of chunks) {
            // Generate embedding
            const embedding = await embeddingService.generateEmbedding(chunk.codeChunkText);

            // Store embedding
            await storeEmbedding(chunk, embedding, relativePath, repoId, commitSha);
          }

          processedFiles.push(relativePath);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to process file`, {
            path: fullFilePath,
            error: errorMessage,
          });
          // Continue with other files
        }
      })
    );
  }

  return processedFiles;
}

/**
 * Store embedding in Convex database
 */
async function storeEmbedding(
  chunk: EmbeddingChunk,
  embedding: number[],
  filePath: string,
  repositoryId: string,
  commitSha: string
): Promise<void> {
  // Call the Convex mutation with the required arguments
  await convex.mutation(api.embeddings.storeEmbedding, {
    embedding,
    repositoryId: repositoryId,
    filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    language: chunk.language,
    chunkType: chunk.chunkType,
    symbolName: chunk.symbolName ?? undefined,
    commitSha,
  });
}

/**
 * Update indexing status in database
 */
async function updateIndexingStatus(
  repositoryId: string,
  status: IndexingStatus,
  error?: string
): Promise<void> {
  try {
    await convex.mutation(api.repositories.updateIndexingStatus, {
      repositoryId,
      status,
    });
  } catch (dbError) {
    logger.error('Failed to update status in database' + error, {
      repositoryId,
      status,
      error: dbError instanceof Error ? dbError.message : String(dbError),
    });
  }
}

/**
 * Clean up repository directory
 */
async function cleanupRepository(cloneDir: string): Promise<void> {
  logger.info(`Cleaning up repository`, { cloneDir });
  try {
    await fs.access(cloneDir).then(
      async () => {
        await fs.rm(cloneDir, { recursive: true, force: true });
        logger.info('Repository cleanup successful');
      },
      () => logger.info('No cleanup needed, directory does not exist')
    );
  } catch (cleanupError) {
    logger.error('Repository cleanup failed', {
      cloneDir,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}
