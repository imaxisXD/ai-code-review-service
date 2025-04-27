// src/services/embedding-service.ts
import OpenAI from 'openai';
import { Logger } from '../utils/logger';

interface EmbeddingServiceOptions {
  logger: Logger;
  openAIApiKey?: string;
  embeddingModel?: string;
}

export class EmbeddingService {
  private logger: Logger;
  private openai: OpenAI;
  private embeddingModel: string;
  private MAX_RETRIES = 3;
  private RETRY_DELAY_MS = 1000;

  constructor(options: EmbeddingServiceOptions) {
    this.logger = options.logger;
    this.openai = new OpenAI({
      apiKey: options.openAIApiKey || process.env.OPENAI_API_KEY,
    });
    this.embeddingModel = options.embeddingModel || 'text-embedding-3-small';
  }

  /**
   * Generate embedding for text with retry logic
   */
  public async generateEmbedding(text: string): Promise<number[]> {
    const truncatedText = this.truncateText(text);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.logger.debug('Generating embedding', {
          attempt,
          textLength: truncatedText.length,
        });

        const response = await this.openai.embeddings.create({
          model: this.embeddingModel,
          input: truncatedText,
        });

        return response.data[0].embedding;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        this.logger.warn('Embedding generation failed', {
          attempt,
          error: lastError.message,
        });

        if (attempt < this.MAX_RETRIES) {
          // Add exponential backoff
          const delay = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          this.logger.debug(`Retrying after delay`, { delay });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Failed to generate embedding after retries');
  }

  /**
   * Truncate text to avoid token limits
   */
  private truncateText(text: string): string {
    // OpenAI's text-embedding-3-small has an 8191 token limit
    // A very rough approximation is ~4 chars per token
    const MAX_CHARS = 8000 * 4;

    if (text.length <= MAX_CHARS) {
      return text;
    }

    this.logger.debug('Truncating text for embedding', {
      originalLength: text.length,
      truncatedLength: MAX_CHARS,
    });

    return text.slice(0, MAX_CHARS);
  }
}
