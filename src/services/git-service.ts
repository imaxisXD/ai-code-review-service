// src/services/git-service.ts
import { simpleGit as createSimpleGit, SimpleGit } from 'simple-git';
import { Logger } from '../utils/logger.js';
import { execSync } from 'child_process';

interface GitOptions {
  logger: Logger;
  githubToken?: string;
}

/**
 * Get authenticated URL if necessary
 */
function getAuthenticatedUrl(repoUrl: string, githubToken?: string, logger?: Logger): string {
  if (repoUrl.includes('github.com') && githubToken) {
    // Remove any trailing slashes from the URL
    const cleanUrl = repoUrl.replace(/\/+$/, '');

    // Make sure to use the correct format for GitHub authentication
    const authUrl = cleanUrl.replace('https://', `https://oauth2:${githubToken}@`);

    if (logger) {
      logger.debug('Using authenticated URL', {
        originalUrl: repoUrl.replace(/\/+$/, ''),
        authUrlMasked: authUrl.replace(githubToken, '[REDACTED]'),
      });
    }

    return authUrl;
  }
  return repoUrl;
}

/**
 * Create git service functions
 */
export function createGitService(options: GitOptions) {
  const logger = options.logger;
  const githubToken = options.githubToken;

  /**
   * Initialize simple-git instance
   */
  function getSimpleGit(baseDir: string): SimpleGit {
    // Add custom git configuration
    try {
      // Set Git to use HTTPS instead of Git protocol
      execSync('git config --global url."https://".insteadOf git://', { stdio: 'ignore' });

      // Increase HTTP buffer size to handle large repositories
      execSync('git config --global http.postBuffer 1048576000', { stdio: 'ignore' });

      // Set longer timeouts
      execSync('git config --global http.lowSpeedLimit 1000', { stdio: 'ignore' });
      execSync('git config --global http.lowSpeedTime 60', { stdio: 'ignore' });
    } catch (error) {
      logger.warn('Failed to set git config', { error: String(error) });
    }

    return createSimpleGit({ baseDir, binary: 'git' });
  }

  /**
   * Clone repository and return SimpleGit instance for the cloned repo
   */
  async function cloneRepository(
    repoUrl: string,
    targetDir: string,
    options: string[] = []
  ): Promise<SimpleGit> {
    const authenticatedUrl = getAuthenticatedUrl(repoUrl, githubToken, logger);
    const git = getSimpleGit(process.cwd());

    logger.debug('Cloning repository', {
      repoUrl: repoUrl.replace(githubToken || '', '[REDACTED]'),
      targetDir,
      options,
    });

    try {
      await git.clone(authenticatedUrl, targetDir, options);
      logger.debug('Clone successful');
    } catch (error) {
      logger.error('Clone failed', {
        error: String(error),
        repoUrl: repoUrl.replace(githubToken || '', '[REDACTED]'),
      });
      throw error;
    }

    // Return SimpleGit instance for the cloned repo
    return getSimpleGit(targetDir);
  }

  /**
   * Get HEAD commit of a repository
   */
  async function getHeadCommit(git: SimpleGit): Promise<string> {
    const result = await git.revparse(['HEAD']);
    return result.trim();
  }

  /**
   * Get diff summary between two commits
   */
  async function getDiffSummary(git: SimpleGit, fromSha: string, toSha: string) {
    logger.debug('Getting diff summary', { fromSha, toSha });
    return await git.diffSummary([`${fromSha}..${toSha}`]);
  }

  /**
   * Get branches of a repository
   */
  async function getBranches(git: SimpleGit) {
    return await git.branch();
  }

  /**
   * Checkout specific branch or commit
   */
  async function checkout(git: SimpleGit, ref: string) {
    logger.debug('Checking out ref', { ref });
    return await git.checkout(ref);
  }

  return {
    getSimpleGit,
    cloneRepository,
    getHeadCommit,
    getDiffSummary,
    getBranches,
    checkout,
  };
}
