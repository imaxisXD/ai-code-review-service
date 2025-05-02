import { ConvexHttpClient } from 'convex/browser';
import { EmbeddingChunk } from '../types';
import { api } from '../convex/api';
import { logger } from '../utils/logger';
import OpenAI from 'openai';

// Function for embedding generation with retry logic
export async function generateEmbedding(text: string, openai: OpenAI): Promise<number[]> {
  // Truncate text to avoid token limits
  // OpenAI's text-embedding-3-small has an 8191 token limit
  // A very rough approximation is ~4 chars per token
  const MAX_CHARS = 8000 * 4;
  const truncatedText = text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS);

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 1000;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.debug('Generating embedding', {
        attempt,
        textLength: truncatedText.length,
      });

      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
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

// Function to store embedding in Convex database
export async function storeEmbedding(
  chunk: EmbeddingChunk,
  embedding: number[],
  filePath: string,
  repositoryId: string,
  commitSha: string,
  convexClient: ConvexHttpClient
): Promise<void> {
  // Call the Convex mutation with the required arguments
  await convexClient.mutation(api.embeddings.storeEmbedding, {
    embedding,
    repositoryId: repositoryId,
    filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    language: chunk.language,
    chunkType: chunk.chunkType,
    symbolName: chunk.symbolName ?? undefined,
    commitSha,
  });
}
