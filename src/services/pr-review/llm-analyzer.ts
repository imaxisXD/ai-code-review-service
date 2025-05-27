import OpenAI from 'openai';
import { ConvexHttpClient } from 'convex/browser';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { api } from '../../convex/api.js';
import { logger } from '../../utils/logger.js';
import { LLMAnalysisResult, ProcessedFile, ReviewConfig } from './types.js';
import { CircuitBreaker } from './circuit-breaker.js';

/**
 * LLM Analysis Module
 *
 * Handles AI-powered code review using Anthropic's Claude model
 * with structured output and robust error handling.
 */

/**
 * Get similar code context using embeddings
 */
export async function getSimilarCodeContext(
  file: ProcessedFile,
  repositoryId: string,
  openai: OpenAI,
  convex: ConvexHttpClient,
  config: ReviewConfig['embeddingConfig']
): Promise<any[]> {
  try {
    logger.info('Searching for similar code context', {
      path: file.path,
      language: file.language,
      repositoryId: repositoryId.substring(0, 8) + '...',
    });

    // Generate embedding for the changed code
    const embedding = await openai.embeddings.create({
      model: config.model,
      input: file.content.substring(0, config.maxInputLength),
    });

    // Search for similar code
    const similarCode = await convex.action(api.embeddings.searchSimilarCode, {
      embedding: embedding.data[0].embedding,
      repositoryId: repositoryId as any, // Convert string to Convex ID type
      language: file.language,
      limit: config.similarCodeLimit,
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
 * Analyze code using LLM with structured output and robust retry logic
 */
export async function analyzeCodeWithLLM(
  file: ProcessedFile,
  similarCode: any[],
  config: ReviewConfig,
  circuitBreaker: CircuitBreaker
): Promise<LLMAnalysisResult> {
  const contextInfo =
    similarCode.length > 0
      ? `\n\nSimilar code patterns in this repository:\n${similarCode
          .map(
            (c) => `File: ${c.filePath} (lines ${c.startLine}-${c.endLine})\nType: ${c.chunkType}`
          )
          .join('\n\n')}`
      : '';

  // Determine change type based on diff content
  let changeType = 'unknown';
  const diffContent = file.diff || file.patch || '';
  if (diffContent.includes('+++') && diffContent.includes('---')) {
    if (diffContent.includes('new file') || diffContent.includes('index 0000000..0000000')) {
      changeType = 'new file';
    } else if (diffContent.includes('deleted file')) {
      changeType = 'deleted file';
    } else {
      changeType = 'modification';
    }
  } else if (diffContent.includes('@@ -0,0 +1,')) {
    // This is likely our synthetic diff for a new/modified file
    changeType = 'file review (no diff available)';
  }

  const prompt = createAnalysisPrompt(file, diffContent, contextInfo, changeType);

  // Check circuit breaker state
  if (!circuitBreaker.canExecute()) {
    logger.warn('Circuit breaker is open - skipping API call', {
      filePath: file.path,
      timeUntilReset: circuitBreaker.getStatus().timeUntilReset,
    });
    return {
      summary: 'Analysis skipped due to API overload protection. Please try again later.',
      issues: [],
    };
  }

  // Retry configuration for handling API overload
  const MAX_RETRIES = Math.max(1, config.retryConfig.maxRetries);
  const BASE_DELAY = config.retryConfig.baseDelayMs;
  const MAX_DELAY = config.retryConfig.maxDelayMs;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('Attempting LLM analysis', {
        attempt,
        maxRetries: MAX_RETRIES,
        filePath: file.path,
      });

      const result = await generateObject({
        model: anthropic('claude-4-sonnet-20250514'),
        schema: z.object({
          summary: z.string(),
          issues: z.array(
            z.object({
              line: z.number(),
              severity: z.enum(['critical', 'warning', 'info']),
              category: z.enum(['security', 'bug', 'performance', 'maintainability']),
              message: z.string(),
              suggestion: z.string(),
              explanation: z.string(),
            })
          ),
        }),
        system: createSystemPrompt(file.language, changeType),
        prompt: prompt,
        maxRetries: 0, // Disable AI SDK's internal retries since we're handling them manually
      });

      logger.info('LLM analysis successful', {
        attempt,
        filePath: file.path,
        summary: result.object.summary,
        issuesCount: result.object.issues.length,
        issues: result.object.issues.map((issue) => ({
          line: issue.line,
          severity: issue.severity,
          category: issue.category,
          message: issue.message.substring(0, 100) + (issue.message.length > 100 ? '...' : ''),
        })),
      });

      // Reset circuit breaker on success
      circuitBreaker.recordSuccess();

      return result.object;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isOverloadError = CircuitBreaker.isOverloadError(error as Error);

      logger.warn('LLM analysis attempt failed', {
        attempt,
        maxRetries: MAX_RETRIES,
        error: errorMessage,
        isOverloadError,
        filePath: file.path,
      });

      // If this is the last attempt, log the final error and return fallback
      if (attempt === MAX_RETRIES) {
        // Update circuit breaker on overload errors
        circuitBreaker.recordFailure(isOverloadError);

        logger.error('LLM analysis failed after all retries', {
          totalAttempts: MAX_RETRIES,
          finalError: errorMessage,
          filePath: file.path,
          circuitBreakerOpen: circuitBreaker.getStatus().isOpen,
        });
        return {
          summary: `Analysis failed after ${MAX_RETRIES} attempts due to API overload. Please try again later.`,
          issues: [],
        };
      }

      // Calculate exponential backoff delay with optional jitter
      const exponentialDelay = Math.min(BASE_DELAY * Math.pow(2, attempt - 1), MAX_DELAY);
      const jitter = config.retryConfig.enableJitter ? Math.random() * 1000 : 0;
      const delay = exponentialDelay + jitter;

      logger.info('Retrying LLM analysis with backoff', {
        attempt,
        nextAttempt: attempt + 1,
        delayMs: Math.round(delay),
        isOverloadError,
      });

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached due to the return in the catch block above
  return { summary: 'Analysis failed unexpectedly', issues: [] };
}

/**
 * Create the analysis prompt for the LLM
 */
function createAnalysisPrompt(
  file: ProcessedFile,
  diffContent: string,
  contextInfo: string,
  changeType: string
): string {
  return `Your task is to conduct a thorough analysis of a code change, applying the same level of scrutiny as a senior engineer would.

IMPORTANT: 
- Do NOT review or comment on code comments, documentation, or comment blocks. Focus only on the actual executable code logic, structure, and implementation.
- Pay special attention to line numbers. Use the line numbers shown in the annotated content below.
- Focus your review on lines marked as [ADDED LINE] or [MODIFIED LINE] as these are the actual changes.
- Lines marked as [COMMENT LINE - FILTERED] should be ignored.

First, review the annotated file content with line numbers:

<annotated_file_content>
\`\`\`${file.language}
${file.annotatedContent}
\`\`\`
</annotated_file_content>

Original file content for context:

<current_file_content>
\`\`\`${file.language}
${file.content}
\`\`\`
</current_file_content>

Next, review the following file context information:

<file_context>
Path: <file_path>${file.path}</file_path>
Language: <language>${file.language}</language>
Change Type: <change_type>${changeType}</change_type>
</file_context>

${getChangeTypeInstructions(changeType)}

Now, examine the code changes:

<code_diff>
\`\`\`diff
${diffContent}
\`\`\`
</code_diff>

Consider any additional context information provided:

<context_info>
${contextInfo}
</context_info>

Your review should focus on the following priorities, in order of importance:

1. CRITICAL (Must Fix):
   - Security vulnerabilities (e.g., injection, XSS, auth bypass)
   - Data corruption or loss risks
   - Memory leaks or resource exhaustion
   - Race conditions or concurrency issues

2. WARNING (Should Fix):
   - Logic errors that could cause incorrect behavior
   - Performance issues in critical paths
   - Error handling gaps
   - API design inconsistencies

3. INFO (Consider):
   - Code readability improvements
   - Better naming or structure
   - Missing documentation for complex logic

Do not flag:
- Stylistic preferences if the code is readable
- Valid alternative approaches
- TODOs or commented code that's clearly intentional
- Minor spacing or formatting (if consistent)

Analyze the code thoroughly, considering:
${getAnalysisInstructions(changeType)}

You must respond with a JSON object containing:
1. "summary": A brief overall assessment of the code change
2. "issues": An array of issue objects, each containing:
   - "line": The EXACT line number from the annotated content where the issue occurs (look for the number at the start of each line like "  42: code here"). Focus on lines marked as [ADDED LINE] or [MODIFIED LINE]. If you cannot determine the exact line, use the closest line number from the changed lines.
   - "severity": One of "critical", "warning", or "info"
   - "category": One of "security", "bug", "performance", or "maintainability"
   - "message": A clear description of the problem
   - "suggestion": A specific fix or improvement recommendation
   - "explanation": Why this issue matters and its potential impact

CRITICAL: When specifying line numbers, use the exact line numbers shown in the annotated content (the numbers at the beginning of each line). Only comment on lines that are marked as [ADDED LINE] or [MODIFIED LINE].

If no actionable issues are found, return an empty issues array and explain this in the summary.`;
}

/**
 * Create the system prompt for the LLM
 */
function createSystemPrompt(language: string, changeType: string): string {
  return `You are an expert code reviewer with over 10 years of experience in ${language} and software engineering best practices. ${
    changeType === 'new file'
      ? `You are reviewing a completely new file being added to the codebase. Pay special attention to overall design, architecture, and how this new code fits into the existing project structure.`
      : changeType === 'modification'
        ? `You are reviewing modifications to an existing file. Focus on the specific changes and their impact on existing functionality.`
        : `You are conducting a comprehensive review of this file. Examine the entire codebase for potential issues.`
  }`;
}

/**
 * Get change type specific instructions
 */
function getChangeTypeInstructions(changeType: string): string {
  switch (changeType) {
    case 'new file':
      return `**This is a NEW FILE being added to the codebase.** Focus on:
- Overall architecture and design patterns
- Code organization and structure
- Naming conventions and clarity
- Security implications of new functionality
- Performance considerations
- Integration with existing codebase
- Missing error handling or edge cases
- Documentation and comments for complex logic`;

    case 'modification':
      return `**This is a MODIFIED FILE with specific changes.** Focus on:
- Impact of changes on existing functionality
- Potential breaking changes
- Backward compatibility
- Changes in behavior or logic
- New bugs introduced by modifications
- Performance impact of changes`;

    case 'file review (no diff available)':
      return `**Full file review (diff unavailable).** Treat as comprehensive review:
- Review entire file for potential issues
- Focus on overall code quality and best practices
- Look for security vulnerabilities
- Check for performance issues
- Verify error handling and edge cases`;

    default:
      return `**Code review for ${changeType}.** Apply standard review practices.`;
  }
}

/**
 * Get analysis instructions based on change type
 */
function getAnalysisInstructions(changeType: string): string {
  if (changeType === 'new file') {
    return `- Overall design and architecture of the new file
- Adherence to project conventions and patterns
- Security implications of new functionality
- Performance considerations for new code
- Error handling and edge case coverage
- Code organization and maintainability
- Integration points with existing codebase
- Missing documentation or unclear logic`;
  } else if (changeType === 'modification') {
    return `- Impact of changes on existing functionality
- Potential bugs or regressions introduced
- Backward compatibility considerations
- Security implications of modifications
- Performance impact of changes
- Code quality improvements or degradations`;
  } else {
    return `- Overall code quality and best practices
- Security vulnerabilities throughout the file
- Performance issues and optimization opportunities
- Error handling and robustness
- Code organization and maintainability
- Adherence to language-specific best practices`;
  }
}
