// src/services/git-service.ts
import simpleGit, { SimpleGit } from 'simple-git';
import { Logger } from '../utils/logger';
import { execSync } from 'child_process';

interface GitServiceOptions {
  logger: Logger;
  githubToken?: string;
}

export class GitService {
  private logger: Logger;
  private githubToken?: string;

  constructor(options: GitServiceOptions) {
    this.logger = options.logger;
    this.githubToken = options.githubToken;
  }

  /**
   * Get authenticated URL if necessary
   */
  private getAuthenticatedUrl(repoUrl: string): string {
    if (repoUrl.includes('github.com') && this.githubToken) {
      // Remove any trailing slashes from the URL
      const cleanUrl = repoUrl.replace(/\/+$/, '');

      // Make sure to use the correct format for GitHub authentication
      const authUrl = cleanUrl.replace('https://', `https://oauth2:${this.githubToken}@`);

      this.logger.debug('Using authenticated URL', {
        originalUrl: repoUrl.replace(/\/+$/, ''),
        authUrlMasked: authUrl.replace(this.githubToken, '[REDACTED]'),
      });

      return authUrl;
    }
    return repoUrl;
  }

  /**
   * Initialize simple-git instance
   */
  public getSimpleGit(baseDir: string): SimpleGit {
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
      this.logger.warn('Failed to set git config', { error: String(error) });
    }

    return simpleGit({ baseDir, binary: 'git' });
  }

  /**
   * Clone repository and return SimpleGit instance for the cloned repo
   */
  public async cloneRepository(
    repoUrl: string,
    targetDir: string,
    options: string[] = []
  ): Promise<SimpleGit> {
    const authenticatedUrl = this.getAuthenticatedUrl(repoUrl);
    const git = this.getSimpleGit(process.cwd());

    this.logger.debug('Cloning repository', {
      repoUrl: repoUrl.replace(this.githubToken || '', '[REDACTED]'),
      targetDir,
      options,
    });

    try {
      await git.clone(authenticatedUrl, targetDir, options);
      this.logger.debug('Clone successful');
    } catch (error) {
      this.logger.error('Clone failed', {
        error: String(error),
        repoUrl: repoUrl.replace(this.githubToken || '', '[REDACTED]'),
      });
      throw error;
    }

    // Return SimpleGit instance for the cloned repo
    return this.getSimpleGit(targetDir);
  }

  /**
   * Get HEAD commit of a repository
   */
  public async getHeadCommit(git: SimpleGit): Promise<string> {
    const result = await git.revparse(['HEAD']);
    return result.trim();
  }

  /**
   * Get diff summary between two commits
   */
  public async getDiffSummary(git: SimpleGit, fromSha: string, toSha: string) {
    this.logger.debug('Getting diff summary', { fromSha, toSha });
    return await git.diffSummary([`${fromSha}..${toSha}`]);
  }

  /**
   * Get branches of a repository
   */
  public async getBranches(git: SimpleGit) {
    return await git.branch();
  }

  /**
   * Checkout specific branch or commit
   */
  public async checkout(git: SimpleGit, ref: string) {
    this.logger.debug('Checking out ref', { ref });
    return await git.checkout(ref);
  }
}
