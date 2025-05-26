import { SimpleGit } from 'simple-git';
import { createGitService } from '../services/git-service.js';
import { shouldProcessFile } from './file-functions.js';
import { getAllFilesRecursive } from './file-functions.js';
import { logger } from '../utils/logger.js';
import path from 'path';

// Function to determine changes
export async function determineChanges(
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
    try {
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
    } catch (error) {
      logger.warn('Error getting diff summary, falling back to initial indexing', {
        error: error instanceof Error ? error.message : String(error),
        beforeSha,
        endSha,
      });

      // Fall back to initial indexing if diff fails
      logger.info('Falling back to initial indexing - getting all files');
      const allFiles = await getAllFilesRecursive(cloneDir);
      filesToProcess = allFiles.filter((file: string) => shouldProcessFile(file));
      filesToDelete = []; // No files to delete in fallback mode
    }
  } else {
    logger.info(
      'No changes detected or missing SHAs for incremental indexing, falling back to initial indexing'
    );
    // Fall back to initial indexing
    const allFiles = await getAllFilesRecursive(cloneDir);
    filesToProcess = allFiles.filter((file: string) => shouldProcessFile(file));
    filesToDelete = [];
  }

  logger.info('Changes determined', {
    filesToProcessCount: filesToProcess.length,
    filesToDeleteCount: filesToDelete.length,
  });

  return { filesToProcess, filesToDelete };
}
