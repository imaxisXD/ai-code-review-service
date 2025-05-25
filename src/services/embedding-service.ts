import OpenAI from 'openai';
import { logger } from '../utils/logger.js';

interface EmbeddingOptions {
  openAIApiKey?: string;
  embeddingModel?: string;
}

// The return type now includes chunk metadata
export interface EmbeddingResult {
  embedding: number[];
  chunk?: {
    index: number;
    total: number;
    text: string;
  };
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
// The token limits for embedding models
const MAX_TOKENS = 8000; // Using a conservative limit below the actual 8192
// Estimate of characters per token for truncation calculation
const CHARS_PER_TOKEN = 3;
// Calculated maximum characters
const MAX_CHARS_PER_CHUNK = MAX_TOKENS * CHARS_PER_TOKEN;
// Overlap between chunks to maintain context
const CHUNK_OVERLAP_CHARS = 500;

/**
 * Checks if content should be skipped for embedding
 * Skips images, SVGs, and other unnecessary file types
 */
function shouldSkipEmbedding(text: string, filename?: string): boolean {
  // Skip empty content
  if (!text || text.trim().length === 0) {
    return true;
  }

  // Skip by file extension if filename is provided
  if (filename) {
    const extension = filename.split('.').pop()?.toLowerCase();
    const skipExtensions = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'pdf'];

    if (extension && skipExtensions.includes(extension)) {
      return true;
    }

    // Skip common gitignore patterns
    const gitignorePatterns = [
      // Build artifacts and dist files
      /\.(o|obj|a|lib|so|dylib|dll|exe)$/i,
      /\/(dist|build|out|target)\/|^\.(dist|build|out|target)$/,

      // Package managers and dependencies
      /\/node_modules\/|^node_modules$/,
      /\/bower_components\/|^bower_components$/,
      /\/vendor\/|^vendor$/,
      /\/packages\/|^packages$/,

      // Logs and databases
      /\.(log|logs)$/i,
      /\.sqlite$|\.db$/i,

      // Environment and config files
      /\.env(\.[^.]+)?$/,
      /\.(local|dev|development|prod|production|test|testing)$/,

      // Cache files
      /\.cache\/|^\.cache$/,
      /\.(swp|swo)$/,

      // OS and editor files
      /\.DS_Store$|Thumbs\.db$/,
      /\.idea\/|\.vscode\/|\.vs\//,
      /\.project$|\.settings\/|\.classpath$/,

      // Lock files
      /package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/,

      // Coverage and test files
      /\/coverage\/|^coverage$/,
      /\.nyc_output\/|^\.nyc_output$/,

      // Minified files (already processed)
      /\.min\.(js|css)$/,

      // Compiled source
      /\.(pyc|class|o|obj)$/,
    ];

    const normalizedPath = filename.replace(/\\/g, '/');

    for (const pattern of gitignorePatterns) {
      if (pattern.test(normalizedPath)) {
        return true;
      }
    }
  }

  // Look for SVG content patterns
  if (text.trim().startsWith('<svg') || text.includes('xmlns="http://www.w3.org/2000/svg"')) {
    return true;
  }

  // Detect binary content or other non-text formats (simplified check)
  const nonTextChars = text
    .slice(0, 1000)
    .split('')
    .filter((char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0))).length;

  // If more than 10% of the first 1000 chars are control characters, likely binary
  if (nonTextChars > 100) {
    return true;
  }

  return false;
}

/**
 * Split text into chunks that fit within token limits
 * with some overlap between chunks to maintain context
 */
function splitIntoChunks(text: string): string[] {
  if (text.length <= MAX_CHARS_PER_CHUNK) {
    return [text];
  }

  const chunks: string[] = [];
  let startPos = 0;

  while (startPos < text.length) {
    const endPos = Math.min(startPos + MAX_CHARS_PER_CHUNK, text.length);
    chunks.push(text.substring(startPos, endPos));

    // Move start position for next chunk, with overlap
    startPos = endPos - CHUNK_OVERLAP_CHARS;

    // If we're near the end and the remaining text is small, just include it in the last chunk
    if (text.length - startPos <= CHUNK_OVERLAP_CHARS * 2) {
      chunks[chunks.length - 1] = text.substring(startPos - (endPos - startPos), text.length);
      break;
    }
  }

  logger.debug('Text split into chunks', {
    originalLength: text.length,
    chunks: chunks.length,
    chunkSizes: chunks.map((c) => c.length),
  });

  return chunks;
}

/**
 * Create embedding service functions
 */
export function createEmbeddingService(options: EmbeddingOptions) {
  const embeddingModel = options.embeddingModel || 'text-embedding-3-small';

  const openai = new OpenAI({
    apiKey: options.openAIApiKey,
  });

  /**
   * Generate embeddings for text with retry logic
   * Returns array of embeddings if text is split into chunks
   */
  async function generateEmbedding(
    text: string,
    filename?: string
  ): Promise<EmbeddingResult[] | null> {
    // Skip embedding for certain file types
    if (shouldSkipEmbedding(text, filename)) {
      logger.debug('Skipping embedding generation for content', {
        reason: 'Content type excluded',
        filename,
      });
      return null;
    }

    // Split text into chunks that fit within token limit
    const chunks = splitIntoChunks(text);
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          logger.debug('Generating embedding', {
            chunk: `${i + 1}/${chunks.length}`,
            attempt,
            textLength: chunk.length,
          });

          const response = await openai.embeddings.create({
            model: embeddingModel,
            input: chunk,
          });

          results.push({
            embedding: response.data[0].embedding,
            chunk:
              chunks.length > 1
                ? {
                    index: i,
                    total: chunks.length,
                    text: chunk,
                  }
                : undefined,
          });

          break; // Success, exit retry loop
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          logger.warn('Embedding generation failed', {
            chunk: `${i + 1}/${chunks.length}`,
            attempt,
            error: lastError.message,
          });

          if (attempt < MAX_RETRIES) {
            // Add exponential backoff
            const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            logger.debug(`Retrying after delay`, { delay });
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (lastError && !results[i]) {
        throw (
          lastError || new Error(`Failed to generate embedding for chunk ${i + 1} after retries`)
        );
      }
    }

    return results;
  }

  return {
    generateEmbedding,
  };
}
