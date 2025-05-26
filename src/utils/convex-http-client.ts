import axios from 'axios';
import { logger } from './logger.js';

/**
 * Simple HTTP client for Convex API
 * This is a basic implementation that can be expanded as needed
 */
export class ConvexHttpClient {
  private apiUrl: string;
  private headers: Record<string, string>;

  constructor(convexUrl: string, apiKey?: string) {
    this.apiUrl = convexUrl;
    this.headers = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      this.headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  /**
   * Execute a Convex mutation
   */
  async mutation<T = any, R = any>(fnName: string, args: T): Promise<R> {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/mutation`,
        {
          name: fnName,
          args,
        },
        {
          headers: this.headers,
        }
      );
      return response.data.result;
    } catch (error) {
      logger.error('Convex mutation failed', {
        fnName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Execute a Convex query
   */
  async query<T = any, R = any>(fnName: string, args: T): Promise<R> {
    try {
      const response = await axios.post(
        `${this.apiUrl}/api/query`,
        {
          name: fnName,
          args,
        },
        {
          headers: this.headers,
        }
      );
      return response.data.result;
    } catch (error) {
      logger.error('Convex query failed', {
        fnName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
