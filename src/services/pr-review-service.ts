/**
 * Pull Request Review Service
 *
 * This file has been refactored into a modular structure for better maintainability.
 * The original large file has been broken down into focused modules:
 *
 * - pr-review/types.ts: Shared interfaces and types
 * - pr-review/config.ts: Configuration and utility functions
 * - pr-review/circuit-breaker.ts: Retry logic and API overload protection
 * - pr-review/file-processor.ts: File content processing and comment removal
 * - pr-review/diff-analyzer.ts: Git diff parsing and line number validation
 * - pr-review/llm-analyzer.ts: AI-powered code analysis
 * - pr-review/comment-manager.ts: Comment validation and deduplication
 * - pr-review/github-integration.ts: GitHub API interactions
 * - pr-review/index.ts: Main orchestration service
 *
 * This modular approach provides:
 * - Better separation of concerns
 * - Easier testing and maintenance
 * - Improved code readability
 * - Reduced file size and complexity
 */

// Re-export the modular PR review service
export { createPullRequestReviewService } from './pr-review/index.js';
