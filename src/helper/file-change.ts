import { SimpleGit } from 'simple-git';
import { createGitService } from '../services/git-service';
import { shouldProcessFile } from './file-functions';
import { getAllFilesRecursive } from './file-functions';
import { logger } from '../utils/logger';
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
