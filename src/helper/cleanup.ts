import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/api';
import { IndexingStatus } from '../types';
import { logger } from '../utils/logger';
import fs from 'fs/promises';

// Function to update indexing status in database
export async function updateIndexingStatus(
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
export async function cleanupRepository(cloneDir: string): Promise<void> {
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
