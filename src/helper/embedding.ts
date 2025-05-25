import { ConvexHttpClient } from 'convex/browser';
import { EnhancedCodeChunk } from '../types.js';
import { api } from '../convex/api.js';
import { logger } from '../utils/logger.js';
import OpenAI from 'openai';
import { createEmbeddingService, EmbeddingResult } from '../services/embedding-service.js';

// Function for embedding generation with retry logic
export async function generateEmbedding(
  text: string,
  openai: OpenAI,
  filename?: string
): Promise<EmbeddingResult[] | null> {
  // Use the embedding service we created
  const embeddingService = createEmbeddingService({
    openAIApiKey: openai.apiKey,
    embeddingModel: 'text-embedding-3-small',
  });

  // This will handle skipping unnecessary files, truncation, and retries
  return embeddingService.generateEmbedding(text, filename);
}

// Function to store embedding in Convex database
export async function storeEmbedding(
  chunk: EnhancedCodeChunk,
  embedding: number[] | null,
  filePath: string,
  repositoryId: string,
  commitSha: string,
  convexClient: ConvexHttpClient
): Promise<void> {
  // Skip storing if the embedding is null (file was skipped)
  if (!embedding) {
    logger.debug('Skipping database storage for skipped embedding', { filePath });
    return;
  }

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
    metadata: chunk.metadata,
    text: chunk.codeChunkText,
  });
}
