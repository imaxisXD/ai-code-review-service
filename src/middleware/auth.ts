import { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { logger } from '../utils/logger.js';
import { Job } from '../types.js';

// Define the type for our context variables
type AppVariables = {
  requestBody: Job;
};

export const createAuthMiddleware = (): MiddlewareHandler<{
  Variables: AppVariables;
}> => {
  return createMiddleware(async (c, next) => {
    try {
      // Get the body text - this will consume the stream
      const bodyText = await c.req.text();
      // Parse the body text into JSON
      const rawBody = JSON.parse(bodyText);
      // Now you can access the data
      const { serviceSecretKey } = rawBody as Job;
      const envSecretKey = process.env.SERVICE_SECRET_KEY;
      if (!envSecretKey) {
        logger.error('SERVICE_SECRET_KEY env variable is missing');
        return c.json(
          {
            status: 'Failed',
            error: 'Server configuration error',
          },
          500
        );
      }

      if (serviceSecretKey !== envSecretKey) {
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
      c.set('requestBody', rawBody as Job);

      // Restore the body for serveWorkflow to use
      const request = new Request(c.req.url, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: bodyText,
      });
      c.req.raw = request;

      await next();
      return;
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
