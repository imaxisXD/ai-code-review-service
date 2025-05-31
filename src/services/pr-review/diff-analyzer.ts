import { DiffAnalysis } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Diff Analysis Module
 *
 * Handles parsing of GitHub patches and creates line number mappings
 * for accurate comment positioning.
 */

/**
 * Parse GitHub patch format to extract diff positions and line mappings
 */
export function parseGitHubPatch(patch: string, fileStatus: string): DiffAnalysis {
  const changedLines = new Set<number>();
  const addedLines = new Set<number>();
  const deletedLines = new Set<number>();
  const validDiffPositions = new Set<number>();
  const validDiffLines = new Set<number>();
  const lineToPositionMap = new Map<number, number>();
  const positionToLineMap = new Map<number, number>();

  const lines = patch.split('\n');
  let currentNewLine = 0;
  let currentOldLine = 0;
  let diffPosition = 0; // GitHub diff position counter

  for (const line of lines) {
    // Parse hunk headers like @@ -1,4 +1,6 @@
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1]);
      currentNewLine = parseInt(hunkMatch[3]);
      diffPosition++; // Hunk headers count as positions
      continue;
    }

    // Skip patch headers
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode')
    ) {
      continue;
    }

    // Process diff content lines
    if (line.startsWith('+')) {
      // Added line
      diffPosition++;
      addedLines.add(currentNewLine);
      changedLines.add(currentNewLine);
      validDiffPositions.add(diffPosition);
      validDiffLines.add(currentNewLine);
      lineToPositionMap.set(currentNewLine, diffPosition);
      positionToLineMap.set(diffPosition, currentNewLine);
      currentNewLine++;
    } else if (line.startsWith('-')) {
      // Deleted line (cannot be commented on in GitHub)
      diffPosition++;
      deletedLines.add(currentOldLine);
      currentOldLine++;
      // Note: We don't add deleted lines to validDiffPositions since they can't be commented on
    } else if (line.startsWith(' ')) {
      // Context line (unchanged) - these can be commented on
      diffPosition++;
      validDiffPositions.add(diffPosition);
      validDiffLines.add(currentNewLine);
      lineToPositionMap.set(currentNewLine, diffPosition);
      positionToLineMap.set(diffPosition, currentNewLine);
      currentNewLine++;
      currentOldLine++;
    }
  }

  // For new files, all lines are considered added
  if (fileStatus === 'added') {
    // GitHub treats new files specially - all lines are valid for comments
    // but we need to ensure we have the correct position mapping
  }

  return {
    changedLines,
    addedLines,
    deletedLines,
    validDiffPositions,
    validDiffLines,
    lineToPositionMap,
    positionToLineMap,
  };
}

/**
 * Validate and correct line numbers based on actual file content and changes
 * Ensures that line numbers correspond to lines that are part of the diff
 */
export function validateAndCorrectLineNumbers(
  issues: Array<{
    line: number;
    severity: 'critical' | 'warning' | 'info';
    category: 'security' | 'bug' | 'performance' | 'maintainability';
    message: string;
    suggestion: string;
    explanation: string;
  }>,
  fileContent: string,
  changedLines: Set<number>,
  addedLines: Set<number>,
  commentLines: Set<number>,
  validDiffLines: Set<number>,
  config: {
    enabled: boolean;
    maxCorrectionDistance: number;
    preferChangedLines: boolean;
  }
): Array<{
  line: number;
  severity: 'critical' | 'warning' | 'info';
  category: 'security' | 'bug' | 'performance' | 'maintainability';
  message: string;
  suggestion: string;
  explanation: string;
}> {
  if (!config.enabled) {
    return issues;
  }

  const totalLines = fileContent.split('\n').length;
  const validatedIssues: Array<{
    line: number;
    severity: 'critical' | 'warning' | 'info';
    category: 'security' | 'bug' | 'performance' | 'maintainability';
    message: string;
    suggestion: string;
    explanation: string;
  }> = [];

  for (const issue of issues) {
    let correctedLine = issue.line;

    // Ensure line number is within file bounds
    if (correctedLine < 1) {
      correctedLine = 1;
    } else if (correctedLine > totalLines) {
      correctedLine = totalLines;
    }

    // CRITICAL: Ensure the line is part of the diff (GitHub requirement)
    if (!validDiffLines.has(correctedLine)) {
      // Try to find the nearest valid diff line
      let nearestValidLine = correctedLine;
      let minDistance = Infinity;

      // First, prefer changed lines (added or modified)
      for (const validLine of validDiffLines) {
        if (changedLines.has(validLine)) {
          const distance = Math.abs(validLine - correctedLine);
          if (distance < minDistance) {
            minDistance = distance;
            nearestValidLine = validLine;
          }
        }
      }

      // If no changed lines found within reasonable distance, try any valid diff line
      if (minDistance > config.maxCorrectionDistance) {
        minDistance = Infinity;
        for (const validLine of validDiffLines) {
          const distance = Math.abs(validLine - correctedLine);
          if (distance < minDistance) {
            minDistance = distance;
            nearestValidLine = validLine;
          }
        }
      }

      // If we found a valid line within reasonable distance, use it
      if (minDistance <= config.maxCorrectionDistance && nearestValidLine !== correctedLine) {
        logger.info('Corrected line number to valid diff line', {
          originalLine: correctedLine,
          correctedLine: nearestValidLine,
          distance: minDistance,
          reason: 'Original line not part of diff',
        });
        correctedLine = nearestValidLine;
      } else {
        // Cannot find a valid line within reasonable distance, skip this comment
        logger.warn('Skipping comment - no valid diff line found', {
          originalLine: correctedLine,
          maxDistance: config.maxCorrectionDistance,
          nearestDistance: minDistance,
          validDiffLinesCount: validDiffLines.size,
          message: issue.message.substring(0, 100),
        });
        continue; // Skip this issue
      }
    }

    // If the line is a comment line, try to find the nearest non-comment valid line
    if (commentLines.has(correctedLine)) {
      // Look for the nearest valid diff line that's not a comment
      let nearestValidLine = correctedLine;
      let minDistance = Infinity;

      for (const validLine of validDiffLines) {
        if (!commentLines.has(validLine)) {
          const distance = Math.abs(validLine - correctedLine);
          if (distance < minDistance) {
            minDistance = distance;
            nearestValidLine = validLine;
          }
        }
      }

      // If we found a better line within reasonable distance, use it
      if (minDistance <= config.maxCorrectionDistance && nearestValidLine !== correctedLine) {
        logger.info('Corrected line number from comment line', {
          originalLine: correctedLine,
          correctedLine: nearestValidLine,
          reason: 'Original line was a comment',
        });
        correctedLine = nearestValidLine;
      }
    }

    // Prefer lines that were actually changed (if enabled and line is still valid)
    if (
      config.preferChangedLines &&
      !changedLines.has(correctedLine) &&
      changedLines.size > 0 &&
      validDiffLines.has(correctedLine) // Ensure we don't break the diff requirement
    ) {
      // Find the nearest changed line that's also a valid diff line
      let nearestChangedLine = correctedLine;
      let minDistance = Infinity;

      for (const changedLine of changedLines) {
        if (validDiffLines.has(changedLine)) {
          const distance = Math.abs(changedLine - correctedLine);
          if (distance < minDistance) {
            minDistance = distance;
            nearestChangedLine = changedLine;
          }
        }
      }

      // If the nearest changed line is within configured distance, use it
      if (minDistance <= config.maxCorrectionDistance) {
        logger.info('Corrected line number to nearest changed line', {
          originalLine: correctedLine,
          correctedLine: nearestChangedLine,
          distance: minDistance,
        });
        correctedLine = nearestChangedLine;
      }
    }

    // Final validation: ensure the corrected line is still valid
    if (validDiffLines.has(correctedLine)) {
      validatedIssues.push({
        ...issue,
        line: correctedLine,
      });
    } else {
      logger.warn('Final validation failed - skipping comment', {
        originalLine: issue.line,
        correctedLine,
        message: issue.message.substring(0, 100),
      });
    }
  }

  const skippedCount = issues.length - validatedIssues.length;
  if (skippedCount > 0) {
    logger.info('Line number validation summary', {
      originalIssues: issues.length,
      validatedIssues: validatedIssues.length,
      skippedIssues: skippedCount,
      validDiffLinesCount: validDiffLines.size,
    });
  }

  return validatedIssues;
}
