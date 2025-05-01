import { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Logger } from '../utils/logger.js';
import { IndexingJob } from '../types.js';

// Define environment type
type AppEnv = {
  SERVICE_SECRET_KEY: string;
};

export const createAuthMiddleware = (logger: Logger): MiddlewareHandler => {
  return createMiddleware(async (c, next) => {
    try {
      const body = await c.req.json<IndexingJob>();
      const serviceSecretKey = body.serviceSecretKey;

      // Get environment variables from context
      const env = c.get('env') as AppEnv;

      if (serviceSecretKey !== env.SERVICE_SECRET_KEY) {
        logger.error('Invalid service secret key');
        return c.json(
          {
            status: 'Failed',
            error: 'Invalid service secret key',
          },
          401
        );
      }

      // Make the validated body available to handlers
      c.set('requestBody', body);
      await next();
    } catch (error) {
      logger.error('Authentication error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          status: 'Failed',
          error: 'Authentication error',
        },
        401
      );
    }
  });
};
