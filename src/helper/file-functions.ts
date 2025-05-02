import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import OpenAI from 'openai';
import { ConvexHttpClient } from 'convex/browser';
import { createTreeSitterService } from '../services/tree-sitter-service';
import { storeEmbedding } from './embedding';
import { generateEmbedding } from './embedding';

// File-related helper functions (moved directly into the handler)
export async function getAllFilesRecursive(dir: string): Promise<string[]> {
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

export function shouldProcessFile(filePath: string): boolean {
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

// Function to process files and generate embeddings
export async function processFiles(
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
