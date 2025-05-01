// src/services/embedding-service.ts
import OpenAI from 'openai';
import { Logger } from '../utils/logger.js';

interface EmbeddingOptions {
  logger: Logger;
  openAIApiKey?: string;
  embeddingModel?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Truncate text to avoid token limits
 */
function truncateText(text: string, logger: Logger): string {
  // OpenAI's text-embedding-3-small has an 8191 token limit
  // A very rough approximation is ~4 chars per token
  const MAX_CHARS = 8000 * 4;

  if (text.length <= MAX_CHARS) {
    return text;
  }

  logger.debug('Truncating text for embedding', {
    originalLength: text.length,
    truncatedLength: MAX_CHARS,
  });

  return text.slice(0, MAX_CHARS);
}

/**
 * Create embedding service functions
 */
export function createEmbeddingService(options: EmbeddingOptions) {
  const logger = options.logger;
  const embeddingModel = options.embeddingModel || 'text-embedding-3-small';

  const openai = new OpenAI({
    apiKey: options.openAIApiKey,
  });

  /**
   * Generate embedding for text with retry logic
   */
  async function generateEmbedding(text: string): Promise<number[]> {
    const truncatedText = truncateText(text, logger);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.debug('Generating embedding', {
          attempt,
          textLength: truncatedText.length,
        });

        const response = await openai.embeddings.create({
          model: embeddingModel,
          input: truncatedText,
        });

        return response.data[0].embedding;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        logger.warn('Embedding generation failed', {
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

    throw lastError || new Error('Failed to generate embedding after retries');
  }

  return {
    generateEmbedding,
  };
}
