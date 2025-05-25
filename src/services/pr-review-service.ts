import { ConvexHttpClient } from 'convex/browser';
import OpenAI from 'openai';
import { createGitService } from './git-service.js';
import { api } from '../convex/api.js';
import { logger } from '../utils/logger.js';
import { PullRequestReviewJob, ReviewComment, PullRequestReviewResult } from '../types.js';
import { SimpleGit } from 'simple-git';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

// Configuration for AI code review
interface ReviewConfig {
  maxFilesPerReview: number;
  maxLinesPerFile: number;
  maxCommentsPerFile: number;
  skipPatterns: string[];
  modelConfig: {
    model: string;
    temperature: number;
    maxTokens: number;
  };
  embeddingConfig: {
    model: string;
    maxInputLength: number;
    similarCodeLimit: number;
  };
}

const DEFAULT_CONFIG: ReviewConfig = {
  maxFilesPerReview: 15,
  maxLinesPerFile: 1000,
  maxCommentsPerFile: 8,
  skipPatterns: [
    'node_modules/**',
    '*.generated.*',
    '*.min.js',
    'dist/**',
    'build/**',
    '*.lock',
    'package-lock.json',
    'yarn.lock',
  ],
  modelConfig: {
    model: 'gpt-4o',
    temperature: 0.1,
    maxTokens: 2000,
  },
  embeddingConfig: {
    model: 'text-embedding-3-small',
    maxInputLength: 8000,
    similarCodeLimit: 5,
  },
};

export function createPullRequestReviewService(deps: {
  convex: ConvexHttpClient;
  openai: OpenAI;
  config?: Partial<ReviewConfig>;
}) {
  const { convex, openai, config: userConfig } = deps;
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  /**
   * Check if a file should be skipped based on patterns
   */
  function shouldSkipFile(filePath: string): boolean {
    return config.skipPatterns.some((pattern) => {
      // Convert glob pattern to regex for simple matching
      const regexPattern = pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.');
      return new RegExp(regexPattern).test(filePath);
    });
  }

  /**
   * Process a pull request review job
   */
  async function processPullRequestReview(
    job: PullRequestReviewJob
  ): Promise<PullRequestReviewResult> {
    const {
      repoId,
      prNumber,
      prTitle,
      prUrl,
      commitSha,
      baseSha,
      installationId,
      owner,
      repo,
      userId,
    } = job;

    let cloneDir = '';

    try {
      logger.info('Starting PR review', {
        repoId,
        prNumber,
        owner,
        repo,
        commitSha: commitSha.substring(0, 7),
        baseSha: baseSha.substring(0, 7),
      });

      // Step 1: Get repository details
      const repository = await convex.query(api.repositories.getRepositoryWithStringId, {
        repositoryId: repoId,
        userId: userId,
      });

      if (!repository) {
        throw new Error(`Repository not found: ${repoId}`);
      }

      // Check embedding availability for this repository
      try {
        // Use a simple search to check if any embeddings exist for this repository
        const testEmbedding = new Array(1536).fill(0); // Create a dummy embedding vector
        const embeddingCheck = await convex.action(api.embeddings.searchSimilarCode, {
          embedding: testEmbedding,
          repositoryId: repository._id as any,
          limit: 1,
        });

        if (embeddingCheck && embeddingCheck.length > 0) {
          logger.info('Repository has embeddings available', {
            repositoryId: repository._id,
            message: 'AI review will include similar code context from existing embeddings',
          });
        } else {
          logger.warn('Repository has no embeddings', {
            repositoryId: repository._id,
            message:
              'AI review will proceed without similar code context. Consider running repository indexing first.',
          });
        }
      } catch (error) {
        logger.warn('Could not check embedding availability', {
          repositoryId: repository._id,
          error: error instanceof Error ? error.message : String(error),
          message: 'AI review will proceed but may lack context',
        });
      }

      // Step 2: Create review record in database
      const reviewId = await convex.mutation(api.github.createPullRequestReview, {
        repositoryId: repository._id,
        prNumber,
        prTitle,
        prUrl,
        commitSha,
      });

      // Step 3: Clone repository and get PR diff
      cloneDir = `/tmp/pr-review-${repo}-${prNumber}-${Date.now()}`;
      const gitService = createGitService({
        githubToken: repository.accessToken,
      });

      const repoGit = await gitService.cloneRepository(repository.cloneUrl, cloneDir);

      // Checkout the PR commit
      await gitService.checkout(repoGit, commitSha);

      // Get the diff between base and head
      const diffSummary = await gitService.getDiffSummary(repoGit, baseSha, commitSha);
      logger.info('Got PR diff', {
        filesChanged: diffSummary.files.length,
        insertions: diffSummary.insertions,
        deletions: diffSummary.deletions,
      });

      // Step 4: Extract changed files and their content
      const changedFiles = await extractChangedFiles(
        repoGit,
        cloneDir,
        diffSummary.files,
        baseSha,
        commitSha,
        gitService
      );

      if (changedFiles.length === 0) {
        logger.info('No files to review in PR', { prNumber });
        return {
          status: 'Success',
          reviewId: reviewId.reviewId,
          commentsPosted: 0,
        };
      }

      // Step 5: Generate code review using LLM
      const reviewComments = await generateCodeReview(changedFiles, repository);

      // Step 6: Post comments to GitHub
      const commentsPosted = await postCommentsToGitHub(
        installationId,
        owner,
        repo,
        prNumber,
        reviewComments,
        commitSha
      );

      logger.info('PR review completed', {
        prNumber,
        commentsPosted: commentsPosted.length,
        reviewId: reviewId.reviewId,
      });

      return {
        status: 'Success',
        reviewId: reviewId.reviewId,
        commentsPosted: commentsPosted.length,
      };
    } catch (error) {
      logger.error('Error processing PR review', {
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        status: 'Failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Clean up
      if (cloneDir) {
        await cleanupRepository(cloneDir);
      }
    }
  }

  /**
   * Extract changed files and their content from the PR
   */
  async function extractChangedFiles(
    repoGit: SimpleGit,
    cloneDir: string,
    files: any[],
    baseSha: string,
    commitSha: string,
    gitService: ReturnType<typeof createGitService>
  ) {
    const changedFiles = [];

    for (const file of files) {
      const filePath = typeof file.file === 'string' ? file.file : file.file?.name;
      if (!filePath || file.binary) continue;

      try {
        // Get the file diff (suppress verbose output)
        const diff = await gitService.getFileDiff(repoGit, baseSha, commitSha, filePath);

        // Get the current file content
        const fs = await import('fs/promises');
        const fullPath = `${cloneDir}/${filePath}`;

        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf8');
        } catch {
          logger.debug('Could not read file, might be deleted', { filePath });
          continue;
        }

        changedFiles.push({
          path: filePath,
          content,
          diff,
          language: getLanguageFromPath(filePath),
        });
      } catch (error) {
        logger.warn('Failed to process file', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return changedFiles;
  }

  /**
   * Generate code review comments using LLM
   */
  async function generateCodeReview(
    changedFiles: any[],
    repository: any
  ): Promise<ReviewComment[]> {
    const reviewComments: ReviewComment[] = [];

    // Filter files based on skip patterns and limits
    const filteredFiles = changedFiles
      .filter((file) => !shouldSkipFile(file.path))
      .filter((file) => file.content.split('\n').length <= config.maxLinesPerFile)
      .slice(0, config.maxFilesPerReview);

    logger.info('Files to review', {
      total: changedFiles.length,
      filtered: filteredFiles.length,
      skipped: changedFiles.length - filteredFiles.length,
    });

    for (const file of filteredFiles) {
      try {
        logger.info('Analyzing file for review', { path: file.path });

        // Get context for this file using existing embeddings
        const similarCode = await getSimilarCodeContext(file, repository._id);

        // Analyze with LLM
        const analysis = await analyzeCodeWithLLM(file, similarCode);

        // Parse LLM response into structured comments
        const fileComments = parseAnalysisIntoComments(analysis, file.path);

        // Limit comments per file to avoid overwhelming developers
        const limitedComments = fileComments.slice(0, config.maxCommentsPerFile);

        if (fileComments.length > config.maxCommentsPerFile) {
          logger.info('Truncated comments for file', {
            path: file.path,
            total: fileComments.length,
            kept: limitedComments.length,
          });
        }

        reviewComments.push(...limitedComments);
      } catch (error) {
        logger.error('Error analyzing file', {
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return reviewComments;
  }

  /**
   * Get similar code context using embeddings
   */
  async function getSimilarCodeContext(file: any, repositoryId: string) {
    try {
      logger.info('Searching for similar code context', {
        path: file.path,
        language: file.language,
        repositoryId: repositoryId.substring(0, 8) + '...',
      });

      // Generate embedding for the changed code
      const embedding = await openai.embeddings.create({
        model: config.embeddingConfig.model,
        input: file.content.substring(0, config.embeddingConfig.maxInputLength),
      });

      // Search for similar code
      const similarCode = await convex.action(api.embeddings.searchSimilarCode, {
        embedding: embedding.data[0].embedding,
        repositoryId: repositoryId as any, // Convert string to Convex ID type
        language: file.language,
        limit: config.embeddingConfig.similarCodeLimit,
      });

      if (similarCode && similarCode.length > 0) {
        logger.info('Found similar code patterns', {
          path: file.path,
          similarCodeCount: similarCode.length,
          patterns: similarCode.map((c: any) => ({
            file: c.filePath,
            type: c.chunkType,
            lines: `${c.startLine}-${c.endLine}`,
          })),
        });
      } else {
        logger.info('No similar code patterns found', {
          path: file.path,
          language: file.language,
          message: 'Repository may not have embeddings indexed yet, or no similar patterns exist',
        });
      }

      return similarCode;
    } catch (error) {
      logger.warn('Failed to get similar code context', {
        path: file.path,
        error: error instanceof Error ? error.message : String(error),
        message: 'This could indicate missing embeddings for the repository',
      });
      return [];
    }
  }

  /**
   * Analyze code using LLM
   */
  async function analyzeCodeWithLLM(file: any, similarCode: any[]) {
    const contextInfo =
      similarCode.length > 0
        ? `\n\nSimilar code patterns in this repository:\n${similarCode
            .map(
              (c) => `File: ${c.filePath} (lines ${c.startLine}-${c.endLine})\nType: ${c.chunkType}`
            )
            .join('\n\n')}`
        : '';

    const prompt = `You are an expert ${file.language} code reviewer with 10+ years of experience. Analyze this code change with the same rigor as a senior engineer.

**File Context:**
- Path: ${file.path}
- Language: ${file.language}
- Change Type: ${file.diff.includes('+') ? 'Addition/Modification' : 'Deletion'}

**Code Changes:**
\`\`\`diff
${file.diff}
\`\`\`

**Current File Content:**
\`\`\`${file.language}
${file.content}
\`\`\`
${contextInfo}

**Review Priorities (focus only on issues that could cause problems):**

🔴 **CRITICAL - Must Fix:**
- Security vulnerabilities (injection, XSS, auth bypass)
- Data corruption or loss risks
- Memory leaks or resource exhaustion
- Race conditions or concurrency issues

🟡 **WARNING - Should Fix:**
- Logic errors that could cause incorrect behavior
- Performance issues in critical paths
- Error handling gaps
- API design inconsistencies

🔵 **INFO - Consider:**
- Code readability improvements
- Better naming or structure
- Missing documentation for complex logic

**DO NOT flag:**
- Stylistic preferences if code is readable
- Valid alternative approaches
- TODOs or commented code that's clearly intentional
- Minor spacing or formatting (if consistent)

**Required Response Format:**
Return ONLY a valid JSON array. Each issue must include specific line numbers and actionable suggestions:

[
  {
    "line": 42,
    "severity": "critical|warning|info",
    "category": "security|bug|performance|maintainability",
    "message": "Specific issue description with context",
    "suggestion": "Exact code fix or specific action to take",
    "explanation": "Why this matters and potential impact"
  }
]

**Examples of good feedback:**
- "Line 15: Potential SQL injection. Use parameterized queries instead of string concatenation."
- "Line 23: This loop has O(n²) complexity. Consider using a Map for O(1) lookups."
- "Line 8: Missing null check could cause runtime error when user is undefined."

Return empty array [] if no actionable issues found.`;

    try {
      const response = await openai.chat.completions.create({
        model: config.modelConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: config.modelConfig.temperature,
        max_tokens: config.modelConfig.maxTokens,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return [];
      }

      // Try to parse JSON response, handling markdown code blocks
      try {
        // Remove markdown code blocks if present
        let jsonContent = content.trim();
        if (jsonContent.startsWith('```json') && jsonContent.endsWith('```')) {
          jsonContent = jsonContent.slice(7, -3).trim();
        } else if (jsonContent.startsWith('```') && jsonContent.endsWith('```')) {
          jsonContent = jsonContent.slice(3, -3).trim();
        }

        return JSON.parse(jsonContent);
      } catch (error) {
        logger.warn('Failed to parse LLM response as JSON', {
          content: content.substring(0, 500) + (content.length > 500 ? '...' : ''),
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    } catch (error) {
      logger.error('LLM analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Parse LLM analysis into review comments
   */
  function parseAnalysisIntoComments(analysis: any[], filePath: string): ReviewComment[] {
    if (!Array.isArray(analysis)) {
      return [];
    }

    return analysis
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const severityEmoji = {
          critical: '🔴',
          warning: '🟡',
          info: '🔵',
        };

        const categoryLabel = {
          security: 'Security',
          bug: 'Bug',
          performance: 'Performance',
          maintainability: 'Code Quality',
        };

        const emoji = severityEmoji[item.severity as keyof typeof severityEmoji] || '⚠️';
        const category = categoryLabel[item.category as keyof typeof categoryLabel] || 'General';

        let body = `${emoji} **${category}**: ${item.message || 'Issue detected'}`;

        if (item.suggestion) {
          body += `\n\n💡 **Suggestion**: ${item.suggestion}`;
        }

        if (item.explanation) {
          body += `\n\n📝 **Why this matters**: ${item.explanation}`;
        }

        // Add AI signature
        body += '\n\n---\n*🤖 Generated by AI Code Review*';

        return {
          path: filePath,
          line: item.line || 1,
          body,
          severity: (['info', 'warning', 'critical'].includes(item.severity)
            ? item.severity === 'critical'
              ? 'error'
              : item.severity
            : 'info') as 'info' | 'warning' | 'error',
          category: item.category || 'general',
          suggestion: item.suggestion,
        };
      });
  }

  /**
   * Post review comments to GitHub using GitHub App authentication
   */
  async function postCommentsToGitHub(
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
    comments: ReviewComment[],
    commitSha: string
  ) {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_PRIVATE_KEY;

    if (!appId || !privateKey) {
      logger.warn('GitHub App credentials not configured, logging comments instead');
      return logCommentsInstead(comments, { installationId, owner, repo, prNumber, commitSha });
    }

    try {
      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId,
          privateKey,
          installationId,
        },
      });

      const postedComments = [];

      // Post individual line comments
      for (const comment of comments) {
        try {
          const response = await octokit.pulls.createReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            commit_id: commitSha,
            path: comment.path,
            line: comment.line,
            body: comment.body,
          });

          postedComments.push(response.data);
          logger.info('Posted review comment', {
            path: comment.path,
            line: comment.line,
            commentId: response.data.id,
          });
        } catch (error) {
          logger.warn('Failed to post individual comment', {
            path: comment.path,
            line: comment.line,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Post summary comment if there are issues
      if (comments.length > 0) {
        const summary = generateReviewSummary(comments);
        try {
          const summaryResponse = await octokit.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: summary,
          });

          logger.info('Posted review summary', {
            commentId: summaryResponse.data.id,
            commentsCount: comments.length,
          });
        } catch (error) {
          logger.warn('Failed to post summary comment', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return postedComments;
    } catch (error) {
      logger.error('Failed to authenticate with GitHub', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fall back to logging
      return logCommentsInstead(comments, { installationId, owner, repo, prNumber, commitSha });
    }
  }

  /**
   * Fallback to log comments when GitHub API is not available
   */
  function logCommentsInstead(
    comments: ReviewComment[],
    context: {
      installationId: number;
      owner: string;
      repo: string;
      prNumber: number;
      commitSha: string;
    }
  ) {
    logger.info('Logging review comments instead of posting to GitHub', {
      ...context,
      commitSha: context.commitSha.substring(0, 7),
      commentsCount: comments.length,
    });

    const postedComments = [];

    for (const comment of comments) {
      logger.info('Review comment', {
        path: comment.path,
        line: comment.line,
        severity: comment.severity,
        category: comment.category,
        body: comment.body.substring(0, 200) + (comment.body.length > 200 ? '...' : ''),
      });

      postedComments.push({ id: Math.random().toString(), path: comment.path, line: comment.line });
    }

    if (comments.length > 0) {
      const summary = generateReviewSummary(comments);
      logger.info('Review summary', { summary });
    }

    return postedComments;
  }

  /**
   * Generate a review summary
   */
  function generateReviewSummary(comments: ReviewComment[]): string {
    const criticalCount = comments.filter((c) => c.severity === 'error').length;
    const warningCount = comments.filter((c) => c.severity === 'warning').length;
    const infoCount = comments.filter((c) => c.severity === 'info').length;

    let summary = `## 🔍 Code Review Summary\n\n`;
    summary += `I've analyzed your pull request and found ${comments.length} item(s) for your consideration:\n\n`;

    if (criticalCount > 0) {
      summary += `- 🚨 **${criticalCount} Critical issue(s)** that should be addressed\n`;
    }
    if (warningCount > 0) {
      summary += `- ⚠️ **${warningCount} Warning(s)** worth reviewing\n`;
    }
    if (infoCount > 0) {
      summary += `- ℹ️ **${infoCount} Suggestion(s)** for improvement\n`;
    }

    summary += `\nPlease review the inline comments for details. Each comment includes specific suggestions for improvement.`;

    if (criticalCount === 0) {
      summary += `\n\n✅ No critical issues detected. Great work!`;
    }

    return summary;
  }

  /**
   * Get language from file path
   */
  function getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      java: 'java',
      kt: 'kotlin',
      swift: 'swift',
      go: 'go',
      rs: 'rust',
      cpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      php: 'php',
      rb: 'ruby',
    };
    return langMap[ext || ''] || 'text';
  }

  /**
   * Clean up repository directory
   */
  async function cleanupRepository(cloneDir: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      await fs.rm(cloneDir, { recursive: true, force: true });
      logger.info('Repository cleanup successful', { cloneDir });
    } catch (error) {
      logger.error('Repository cleanup failed', {
        cloneDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    processPullRequestReview,
  };
}
