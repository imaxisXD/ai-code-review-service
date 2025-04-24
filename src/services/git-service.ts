// src/services/git-service.ts
import simpleGit, { SimpleGit } from 'simple-git';
import { Logger } from '../utils/logger';

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
      return repoUrl.replace('https://', `https://x-access-token:${this.githubToken}@`);
    }
    return repoUrl;
  }

  /**
   * Initialize simple-git instance
   */
  public getSimpleGit(baseDir: string): SimpleGit {
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
      options
    });
    
    await git.clone(authenticatedUrl, targetDir, options);
    
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