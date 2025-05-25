import { Hono } from 'hono';
import { createAuthMiddleware } from './middleware/auth.js';
import { createLoggerMiddleware } from './middleware/logger.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { serve } from '@hono/node-server';
import OpenAI from 'openai';
import { ConvexHttpClient } from 'convex/browser';
import { logger } from './utils/logger.js';
import { IndexingJob, Job } from './types.js';
import { createPubSubPublisher } from './services/pubsub-service.js';
import { createJobProcessor } from './services/job-processor.js';

// --- Environment Variable Caching ---
// Read environment variables once at startup
const {
  OPENAI_API_KEY,
  CONVEX_URL,
  SERVICE_SECRET_KEY,
  GOOGLE_PROJECT_ID,
  PUBSUB_TOPIC,
  PUBSUB_SUBSCRIPTION,
} = process.env;

logger.info('Environment variables', {
  OPENAI_API_KEY,
  CONVEX_URL,
  SERVICE_SECRET_KEY,
  GOOGLE_PROJECT_ID,
  PUBSUB_TOPIC,
  PUBSUB_SUBSCRIPTION,
});

// Validate required environment variables
if (!OPENAI_API_KEY) {
  throw new Error('Missing required environment variable: OPENAI_API_KEY');
}
if (!CONVEX_URL) {
  throw new Error('Missing required environment variable: CONVEX_URL');
}
if (!SERVICE_SECRET_KEY) {
  throw new Error('Missing required environment variable: SERVICE_SECRET_KEY');
}

// Initialize Convex client
const convex = new ConvexHttpClient(CONVEX_URL);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const pubSubService = createPubSubPublisher({
  projectId: 'hono-backend-458311',
  topicName: 'repo-indexing-jobs',
});

// Initialize job processor
const jobProcessor = createJobProcessor({
  convex,
  openai,
});

const app = new Hono<{ Variables: AppVariables }>();

// Create application with typed context
type AppVariables = {
  requestBody: Job;
};

// Add error handling middleware
app.use('*', createErrorHandler());

// Add logger middleware
app.use('*', createLoggerMiddleware());

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
  });
});

app.post('/pubsub-push-handler', async (c) => {
  logger.info('Received request on /pubsub-push-handler');
  try {
    // 1. --- Validate Pub/Sub Format ---
    const body = await c.req.json(); // Use Hono's built-in JSON parsing
    if (!body || !body.message || !body.message.data) {
      const msg = 'Invalid Pub/Sub message format received.';
      logger.error(msg, { receivedBody: body });
      return c.text(`Bad Request: ${msg}`, 400); // Return 400 - don't retry bad format
    }

    // 2. --- Decode Job Payload ---
    const pubSubMessage = body.message;
    let jobPayload: IndexingJob; // Use your IndexingJob type
    try {
      const dataBuffer = Buffer.from(pubSubMessage.data, 'base64');
      const dataString = dataBuffer.toString('utf-8');
      jobPayload = JSON.parse(dataString);
      logger.info('Decoded Pub/Sub Job Payload:', { jobPayload });
    } catch (parseError) {
      logger.error('Failed to decode/parse Pub/Sub message data', { error: parseError });
      return c.text('Bad Request: Invalid message data format', 400); // Return 400
    }

    // 3. --- Process the Job ---
    logger.info(
      `Starting job processing for repoId: ${jobPayload.repoId}, type: ${jobPayload.jobType}`
    );
    try {
      await jobProcessor.processJob(jobPayload as Job); // Call your core logic
      logger.info(`Finished job processing successfully for repoId: ${jobPayload.repoId}`);
    } catch (error) {
      logger.error('Error processing job', {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.text('Internal Server Error: Job processing failed', 500);
    }

    // 4. --- Acknowledge Pub/Sub Message ---
    // Return 2xx status code to signal success to Pub/Sub
    return c.body(null, 204); // 204 No Content is appropriate
  } catch (processingError) {
    const errorMessage =
      processingError instanceof Error ? processingError.message : String(processingError);
    logger.error('Error processing job received from Pub/Sub', { error: errorMessage });

    // 5. --- Signal Failure to Pub/Sub ---
    // Return non-2xx (e.g., 500) to make Pub/Sub retry the message
    // based on the subscription's retry policy.
    // Be careful: if the error is permanent, this could lead to infinite retries
    // polluting the DLQ. Add logic here to maybe return 2xx for permanent errors
    // if you want them sent directly to the DLQ after first failure.
    return c.text('Internal Server Error: Job processing failed', 500);
  }
});

// Apply auth middleware to protected routes - Pass cached secret key
app.all('/indexing-job', createAuthMiddleware(), async (c) => {
  try {
    // Get the already parsed body from the context
    const parsedBody = c.get('requestBody');
    logger.info('Parsed body after auth middleware', {
      parsedBody,
      repoId: parsedBody.repoId,
      jobType: parsedBody.jobType,
      userId: parsedBody.userId,
    });

    // Now you can access the data
    const { repoId, jobType, userId } = parsedBody;

    if (!repoId) {
      logger.error('Missing required fields', { repoId });
      return c.json(
        {
          status: 'Failed',
          error: 'Missing required fields: repoId is required',
        },
        400
      );
    }
    if (!userId) {
      logger.error('Missing required fields', { userId });
      return c.json(
        {
          status: 'Failed',
          error: 'Missing required fields: userId is required',
        },
        400
      );
    }
    if (typeof repoId !== 'string' || typeof userId !== 'string' || typeof jobType !== 'string') {
      return c.json(
        {
          status: 'Failed',
          error: 'Invalid request body: repoId, userId, and jobType must be strings',
        },
        400
      );
    }

    // Validate job type
    if (!['initial', 'incremental', 'pr_review'].includes(jobType)) {
      return c.json(
        {
          status: 'Failed',
          error: 'Invalid jobType. Must be initial, incremental, or pr_review',
        },
        400
      );
    }

    logger.info('Queueing indexing job', { repoId, userId, jobType });

    try {
      // Publish the job to Pub/Sub
      const messageId = await pubSubService.publishMessage(parsedBody);

      // Return success response
      return c.json({
        status: 'Queued',
        messageId,
      });
    } catch (pubsubError) {
      logger.error('Error publishing to Pub/Sub', {
        error: pubsubError instanceof Error ? pubsubError.message : String(pubsubError),
      });
      return c.json(
        {
          status: 'Failed',
          error: 'Failed to queue indexing job',
        },
        500
      );
    }
  } catch (error) {
    logger.error('Error processing indexing job', {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      {
        status: 'Failed',
        error: 'An error occurred while processing the indexing job',
      },
      500
    );
  }
});

// Method not allowed for other methods on root path
app.all('/', (c) => c.text('Method Not Allowed', 405));

serve({
  fetch: app.fetch,
  port: 8080,
});
