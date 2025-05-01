import { MiddlewareHandler } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { Logger } from '../utils/logger.js';

export const createLoggerMiddleware = (customLogger: Logger): MiddlewareHandler => {
  // Create a custom print function for the Hono logger
  const printFunc = (str: string, ...rest: string[]) => {
    customLogger.info(str + (rest.length > 0 ? ' ' + rest.join(' ') : ''));
  };

  // Return Hono's logger middleware with our custom print function
  const middleware = honoLogger(printFunc);
  return middleware;
};
