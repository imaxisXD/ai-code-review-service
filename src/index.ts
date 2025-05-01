import { Hono } from 'hono';
import { Logger } from './utils/logger.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createLoggerMiddleware } from './middleware/logger.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { serve } from '@hono/node-server';
import OpenAI from 'openai';
import path from 'path';
import fs from 'fs/promises';
import { IndexingJob, IndexingStatus, EmbeddingChunk } from './types.js';
import { ConvexHttpClient } from 'convex/browser';
import { api } from './convex/api.js';
import { createGitService } from './services/git-service.js';
import { createTreeSitterService } from './services/tree-sitter-service.js';
import { SimpleGit } from 'simple-git';

// --- Environment Variable Caching ---
// Read environment variables once at startup
const { OPENAI_API_KEY, CONVEX_URL, SERVICE_SECRET_KEY, LOG_LEVEL, PORT } = process.env;

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

// --- Service Initialization ---
// Define allowed log levels (adjust if your Logger uses different values)
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const allowedLogLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Validate and set log level
const validatedLogLevel: LogLevel | undefined =
  LOG_LEVEL && allowedLogLevels.includes(LOG_LEVEL.toLowerCase() as LogLevel)
    ? (LOG_LEVEL.toLowerCase() as LogLevel)
    : undefined; // Or set a default like 'info'

// Initialize logger
const logger = new Logger({
  service: 'indexing-worker',
  level: validatedLogLevel, // Use validated level
});

// Initialize Convex client
const convex = new ConvexHttpClient(CONVEX_URL);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Initialize TreeSitter service
const treeSitterService = createTreeSitterService({ logger });

// Create application - Removed Env from Variables
const app = new Hono<{ Variables: { requestBody?: IndexingJob } }>();

// Add error handling middleware
app.use('*', createErrorHandler(logger));

// Add logger middleware
app.use('*', createLoggerMiddleware(logger));

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
  });
});

// Create a nested router for indexing - Removed Env from Variables
const indexingRouter = new Hono<{ Variables: { requestBody?: IndexingJob } }>();

// Apply auth middleware to protected routes - Pass cached secret key
indexingRouter.post('/', createAuthMiddleware(logger, SERVICE_SECRET_KEY), async (c) => {
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
      logger,
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

// File-related helper functions (moved directly into the handler)
async function getAllFilesRecursive(dir: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      return dirent.isDirectory() ? getAllFilesRecursive(res) : res;
    })
  );
  return files.flat();
}

const IGNORE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.tiff',
  '.ico',
  '.svg',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.ogg',
  '.wav',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.exe',
  '.dll',
  '.so',
  '.o',
  '.obj',
  '.class',
];

const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.vercel',
  '.github',
  '.vscode',
  'coverage',
  '.cache',
];

function shouldProcessFile(filePath: string): boolean {
  // Skip files with ignored extensions
  const extension = path.extname(filePath).toLowerCase();
  if (IGNORE_EXTENSIONS.includes(extension)) {
    return false;
  }

  // Skip files in ignored directories
  const pathParts = filePath.split(path.sep);
  for (const dir of IGNORE_DIRS) {
    if (pathParts.includes(dir)) {
      return false;
    }
  }

  return true;
}

// Function to determine changes
async function determineChanges(
  repoGit: SimpleGit,
  cloneDir: string,
  jobType: string,
  beforeSha: string,
  endSha: string,
  gitService: ReturnType<typeof createGitService>
): Promise<{ filesToProcess: string[]; filesToDelete: string[] }> {
  let filesToProcess: string[] = [];
  let filesToDelete: string[] = [];

  if (jobType === 'initial') {
    logger.info('Initial indexing - getting all files');
    const allFiles = await getAllFilesRecursive(cloneDir);
    filesToProcess = allFiles.filter((file: string) => shouldProcessFile(file));
  } else if (beforeSha && endSha && beforeSha !== endSha) {
    logger.info(`Incremental indexing`, { fromSha: beforeSha, toSha: endSha });
    const diffSummary = await gitService.getDiffSummary(repoGit, beforeSha, endSha);

    filesToDelete = diffSummary.files
      .map((f) => (typeof f.file === 'string' ? f.file : undefined))
      .filter((file): file is string => file !== undefined);

    filesToProcess = diffSummary.files
      .map((f) => {
        return typeof f.file === 'string' ? f.file : undefined;
      })
      .filter((file): file is string => file !== undefined)
      .map((relPath: string) => path.join(cloneDir, relPath));
  } else {
    logger.info('No changes detected or missing SHAs for incremental indexing');
  }

  logger.info('Changes determined', {
    filesToProcess: filesToProcess.length,
    filesToDelete: filesToDelete.length,
  });

  return { filesToProcess, filesToDelete };
}

// Function for embedding generation with retry logic
async function generateEmbedding(text: string, openai: OpenAI): Promise<number[]> {
  // Truncate text to avoid token limits
  // OpenAI's text-embedding-3-small has an 8191 token limit
  // A very rough approximation is ~4 chars per token
  const MAX_CHARS = 8000 * 4;
  const truncatedText = text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS);

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 1000;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.debug('Generating embedding', {
        attempt,
        textLength: truncatedText.length,
      });

      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: truncatedText,
      });

      return response.data[0].embedding;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      logger.warn('Embedding generation failed', {
        attempt,
        error: lastError.message,
      });

      if (attempt < MAX_RETRIES) {
        // Add exponential backoff
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.debug(`Retrying after delay`, { delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Failed to generate embedding after retries');
}

// Function to process files and generate embeddings
async function processFiles(
  cloneDir: string,
  filesToProcess: string[],
  repoId: string,
  commitSha: string,
  openai: OpenAI,
  treeSitterService: ReturnType<typeof createTreeSitterService>,
  convexClient: ConvexHttpClient
): Promise<string[]> {
  const processedFiles: string[] = [];
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB

  logger.info(`Processing files`, { count: filesToProcess.length });

  // Process in batches to avoid memory issues
  const BATCH_SIZE = 20;
  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (fullFilePath) => {
        try {
          // Check file size
          const stats = await fs.stat(fullFilePath).catch(() => null);
          if (!stats || !stats.isFile() || stats.size > MAX_FILE_SIZE) {
            if (stats && stats.size > MAX_FILE_SIZE) {
              logger.debug(`Skipping large file`, { filePath: fullFilePath, size: stats.size });
            }
            return;
          }

          // Read file content
          const content = await fs.readFile(fullFilePath, 'utf8');

          // Get file extension and determine language
          const relativePath = path.relative(cloneDir, fullFilePath);
          const extension = path.extname(relativePath).toLowerCase().slice(1);
          const language = extension || 'txt';

          logger.info(`Processing file`, { path: relativePath });

          // Parse file into chunks using TreeSitter
          const chunks = treeSitterService.parseCodeToChunks(content, language, fullFilePath);

          // Process each chunk
          for (const chunk of chunks) {
            // Generate embedding (using pre-initialized openai client)
            const embedding = await generateEmbedding(chunk.codeChunkText, openai);

            // Store embedding (using passed convex client)
            await storeEmbedding(chunk, embedding, relativePath, repoId, commitSha, convexClient);
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

// Function to store embedding in Convex database
async function storeEmbedding(
  chunk: EmbeddingChunk,
  embedding: number[],
  filePath: string,
  repositoryId: string,
  commitSha: string,
  convexClient: ConvexHttpClient
): Promise<void> {
  // Call the Convex mutation with the required arguments
  await convexClient.mutation(api.embeddings.storeEmbedding, {
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

// Function to update indexing status in database
async function updateIndexingStatus(
  convexClient: ConvexHttpClient,
  repositoryId: string,
  status: IndexingStatus,
  error?: string
): Promise<void> {
  try {
    await convexClient.mutation(api.repositories.updateIndexingStatus, {
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

// Function to clean up repository directory
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

// Mount the indexing router
app.route('/', indexingRouter);

// Method not allowed for other methods on root path
app.all('/', (c) => c.text('Method Not Allowed', 405));

serve({
  fetch: app.fetch,
  port: Number(PORT) || 8080,
});
