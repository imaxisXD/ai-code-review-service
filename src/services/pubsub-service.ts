// src/services/pubsub-service.ts

import { PubSub } from '@google-cloud/pubsub';
import { logger } from '../utils/logger.js';

interface PubSubPublisherConfig {
  projectId: string;
  topicName: string; // Only the topic ID (e.g., 'repo-indexing-jobs')
}

/**
 * Handles publishing messages to Google Pub/Sub.
 * Assumes the topic already exists.
 */
export function createPubSubPublisher(config: PubSubPublisherConfig) {
  const { projectId, topicName } = config;
  const fullTopicName = `projects/${projectId}/topics/${topicName}`;

  // Initialize PubSub client - projectId might be inferred if running on GCP
  const pubsub = new PubSub({ projectId });
  const topic = pubsub.topic(fullTopicName);

  /**
   * Publishes a job message to the configured topic.
   */
  async function publishMessage(data: any): Promise<string> {
    try {
      // Data must be sent as a Buffer
      const dataBuffer = Buffer.from(JSON.stringify(data));

      logger.info(`Publishing message to topic: ${fullTopicName}`, {
        data: /* Avoid logging sensitive data */ data.repoId,
      }); // Log minimally

      const messageId = await topic.publishMessage({ data: dataBuffer });

      logger.info(`Message ${messageId} published successfully.`);
      return messageId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error publishing message to ${fullTopicName}`, { error: errorMessage });
      // Consider how to handle publish failures - maybe retry internally?
      throw new Error(`Failed to publish message: ${errorMessage}`); // Rethrow for caller
    }
  }

  return {
    publishMessage,
  };
}
