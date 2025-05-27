import { logger } from '../../utils/logger.js';

/**
 * File Processing Module
 *
 * Handles file content processing including comment removal and content annotation
 * for better AI analysis.
 */

/**
 * Improved comment removal that tracks which lines were comments
 */
export function removeCommentsFromCodeWithTracking(
  content: string,
  language: string
): {
  filteredContent: string;
  commentLines: Set<number>;
} {
  const lines = content.split('\n');
  const filteredLines: string[] = [];
  const commentLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    const lineNumber = i + 1;

    // Skip empty lines
    if (!trimmedLine) {
      filteredLines.push(line);
      continue;
    }

    // Language-specific comment detection
    let isComment = false;

    switch (language) {
      case 'javascript':
      case 'typescript':
      case 'java':
      case 'kotlin':
      case 'swift':
      case 'go':
      case 'rust':
      case 'cpp':
      case 'c':
      case 'csharp':
        // Single line comments
        if (trimmedLine.startsWith('//')) {
          isComment = true;
        }
        // Multi-line comments (simple detection)
        if (
          trimmedLine.startsWith('/*') ||
          trimmedLine.startsWith('*') ||
          trimmedLine.endsWith('*/')
        ) {
          isComment = true;
        }
        // JSDoc comments
        if (trimmedLine.startsWith('/**') || trimmedLine.startsWith('*')) {
          isComment = true;
        }
        break;

      case 'python':
        // Single line comments
        if (trimmedLine.startsWith('#')) {
          isComment = true;
        }
        // Docstrings (simple detection)
        if (trimmedLine.startsWith('"""') || trimmedLine.startsWith("'''")) {
          isComment = true;
        }
        break;

      case 'ruby':
        // Single line comments
        if (trimmedLine.startsWith('#')) {
          isComment = true;
        }
        break;

      case 'php':
        // Single line comments
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('#')) {
          isComment = true;
        }
        // Multi-line comments
        if (
          trimmedLine.startsWith('/*') ||
          trimmedLine.startsWith('*') ||
          trimmedLine.endsWith('*/')
        ) {
          isComment = true;
        }
        break;

      default:
        // For unknown languages, try to detect common comment patterns
        if (
          trimmedLine.startsWith('//') ||
          trimmedLine.startsWith('#') ||
          trimmedLine.startsWith('/*') ||
          trimmedLine.startsWith('*') ||
          trimmedLine.startsWith('<!--')
        ) {
          isComment = true;
        }
        break;
    }

    // If it's not a comment, include the line
    if (!isComment) {
      filteredLines.push(line);
    } else {
      // Replace comment lines with empty lines to maintain line numbers
      commentLines.add(lineNumber);
      filteredLines.push('');
    }
  }

  return {
    filteredContent: filteredLines.join('\n'),
    commentLines,
  };
}

/**
 * Create enhanced file content with line number annotations and position mapping
 */
export function createAnnotatedFileContentWithPositions(
  content: string,
  changedLines: Set<number>,
  addedLines: Set<number>,
  commentLines: Set<number>,
  lineToPositionMap: Map<number, number>
): string {
  const lines = content.split('\n');
  const annotatedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i];
    const diffPosition = lineToPositionMap.get(lineNumber);

    let annotation = '';
    if (addedLines.has(lineNumber)) {
      annotation = ` // [ADDED LINE - Position: ${diffPosition || 'N/A'}]`;
    } else if (changedLines.has(lineNumber)) {
      annotation = ` // [MODIFIED LINE - Position: ${diffPosition || 'N/A'}]`;
    } else if (commentLines.has(lineNumber)) {
      annotation = ' // [COMMENT LINE - FILTERED]';
    } else if (diffPosition) {
      annotation = ` // [CONTEXT LINE - Position: ${diffPosition}]`;
    }

    annotatedLines.push(`${lineNumber.toString().padStart(4, ' ')}: ${line}${annotation}`);
  }

  return annotatedLines.join('\n');
}

/**
 * Reconstruct file content from a GitHub patch (for new files)
 */
export function reconstructContentFromPatch(patch: string): string {
  const lines = patch.split('\n');
  const contentLines: string[] = [];

  for (const line of lines) {
    // Skip patch headers
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode')
    ) {
      continue;
    }

    // For new files, all content lines start with '+'
    if (line.startsWith('+')) {
      contentLines.push(line.substring(1)); // Remove the '+' prefix
    }
  }

  return contentLines.join('\n');
}

/**
 * Clean up repository directory
 */
export async function cleanupRepository(cloneDir: string): Promise<void> {
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
