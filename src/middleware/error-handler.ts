import { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { logger } from '../utils/logger';

export interface ErrorWithStatus extends Error {
  status?: number;
}

export const createErrorHandler = (): MiddlewareHandler => {
  return createMiddleware(async (c, next) => {
    try {
      await next();
    } catch (error) {
      const err = error as ErrorWithStatus;
      logger.error('Unhandled error', {
        message: err.message,
        stack: err.stack,
      });

      const status = err.status || 500;
      return c.json(
        {
          status: 'Failed',
          error: err.message || 'Internal Server Error',
        },
        status as 400 | 401 | 403 | 404 | 500
      );
    }
  });
};
