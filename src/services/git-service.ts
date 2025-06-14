// src/services/git-service.ts
import { simpleGit as createSimpleGit, SimpleGit } from 'simple-git';
import { logger } from '../utils/logger.js';
import { execSync } from 'child_process';

interface GitOptions {
  githubToken?: string;
}

/**
 * Get authenticated URL if necessary
 */
function getAuthenticatedUrl(repoUrl: string, githubToken?: string): string {
  if (repoUrl.includes('github.com') && githubToken) {
    // Remove any trailing slashes from the URL
    const cleanUrl = repoUrl.replace(/\/+$/, '');

    // Make sure to use the correct format for GitHub authentication
    const authUrl = cleanUrl.replace('https://', `https://oauth2:${githubToken}@`);

    logger.debug('Using authenticated URL', {
      originalUrl: repoUrl.replace(/\/+$/, ''),
      authUrlMasked: authUrl.replace(githubToken, '[REDACTED]'),
    });

    return authUrl;
  }
  return repoUrl;
}

/**
 * Create git service functions
 */
export function createGitService(options: GitOptions) {
  const githubToken = options.githubToken;

  /**
   * Initialize simple-git instance
   */
  function getSimpleGit(baseDir: string): SimpleGit {
    // First, check if git is available
    try {
      execSync('which git', { stdio: 'ignore' });
    } catch (error) {
      logger.error('Git executable not found in PATH. Please ensure Git is installed correctly.', {
        error: String(error),
        path: process.env.PATH,
      });
      throw new Error(
        'Git executable not found. Make sure Git is installed and available in PATH.'
      );
    }

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

    const git = createSimpleGit({
      baseDir,
      binary: 'git',
      config: ['core.quotepath=false', 'diff.noprefix=false', 'log.showSignature=false'],
      trimmed: false,
    });

    // Configure output handler to suppress verbose git output
    git.outputHandler((command, stdout, stderr) => {
      // Suppress stdout completely to reduce log noise from diff commands
      if (stdout) {
        stdout.on('data', () => {
          // Silently consume stdout data to prevent it from being logged
        });
      }

      // Only log stderr if there are actual errors (not warnings)
      if (stderr) {
        stderr.on('data', (data) => {
          const errorText = data.toString().trim();
          if (errorText && !errorText.includes('warning:') && !errorText.includes('hint:')) {
            logger.debug('Git stderr', { command, error: errorText });
          }
        });
      }
    });

    return git;
  }

  /**
   * Clone repository and return SimpleGit instance for the cloned repo
   */
  async function cloneRepository(
    repoUrl: string,
    targetDir: string,
    options: string[] = []
  ): Promise<SimpleGit> {
    const authenticatedUrl = getAuthenticatedUrl(repoUrl, githubToken);
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
        cwd: process.cwd(),
        nodeEnv: process.env.NODE_ENV,
        execPath: process.execPath,
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
    try {
      // Validate inputs
      if (!fromSha || !toSha) {
        throw new Error(`Invalid parameters: fromSha=${fromSha}, toSha=${toSha}`);
      }

      // Validate that both SHAs exist
      try {
        await git.raw(['rev-parse', '--verify', fromSha]);
        await git.raw(['rev-parse', '--verify', toSha]);
      } catch (error) {
        throw new Error(
          `Invalid commit SHA: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      logger.debug('Getting diff summary', {
        fromSha: fromSha.substring(0, 7),
        toSha: toSha.substring(0, 7),
      });

      return await git.diffSummary([`${fromSha}..${toSha}`]);
    } catch (error) {
      logger.error('Failed to get diff summary', {
        fromSha: fromSha?.substring(0, 7),
        toSha: toSha?.substring(0, 7),
        error: error instanceof Error ? error.message : String(error),
      });

      // Return empty diff summary to allow processing to continue
      return {
        changed: 0,
        deletions: 0,
        insertions: 0,
        files: [],
      };
    }
  }

  /**
   * Get file diff with suppressed output
   */
  async function getFileDiff(git: SimpleGit, fromSha: string, toSha: string, filePath: string) {
    try {
      // Validate inputs
      if (!fromSha || !toSha || !filePath) {
        throw new Error(
          `Invalid parameters: fromSha=${fromSha}, toSha=${toSha}, filePath=${filePath}`
        );
      }

      // Validate that both SHAs exist
      try {
        await git.raw(['rev-parse', '--verify', fromSha]);
        await git.raw(['rev-parse', '--verify', toSha]);
      } catch (error) {
        throw new Error(
          `Invalid commit SHA: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Use raw git command with flags to suppress verbose output
      return await git.raw([
        'diff',
        '--no-color',
        '--no-stat',
        `${fromSha}..${toSha}`,
        '--',
        filePath,
      ]);
    } catch (error) {
      logger.error('Failed to get file diff', {
        fromSha: fromSha?.substring(0, 7),
        toSha: toSha?.substring(0, 7),
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return empty diff instead of throwing to allow processing to continue
      return '';
    }
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
    getFileDiff,
    getBranches,
    checkout,
  };
}
