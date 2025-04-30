/* eslint-disable @typescript-eslint/ban-types */
import { FunctionReference, anyApi } from 'convex/server';
import { GenericId as Id } from 'convex/values';

export const api: PublicApiType = anyApi as unknown as PublicApiType;
export const internal: InternalApiType = anyApi as unknown as InternalApiType;

export type PublicApiType = {
  repositories: {
    addRepository: FunctionReference<
      'mutation',
      'public',
      {
        repoArray: Array<{
          accessToken: string;
          branchesToMonitor: Array<string>;
          cloneUrl: string;
          description: string;
          hooksUrl: string;
          isPrivate: boolean;
          language: string;
          mainBranch: string;
          name: string;
          provider: string;
          repositoryId: number;
          repositoryName: string;
          sshUrl: string;
          updatedAt: string;
          url: string;
          webhookId?: string;
          webhookSecret?: string;
        }>;
      },
      any
    >;
    updateRepository: FunctionReference<
      'mutation',
      'public',
      {
        accessToken?: string;
        branchesToMonitor?: Array<string>;
        id: Id<'repositories'>;
        isEnabled?: boolean;
        lastIndexedAt?: number;
        webhookId?: string;
        webhookSecret?: string;
      },
      any
    >;
    deleteRepository: FunctionReference<'mutation', 'public', { id: Id<'repositories'> }, any>;
    getUserRepositories: FunctionReference<'query', 'public', any, any>;
    getRepositoryById: FunctionReference<'query', 'public', { id: Id<'repositories'> }, any>;
    getRepositoryWithStringId: FunctionReference<
      'query',
      'public',
      { repositoryId: string; userId: string },
      {
        _creationTime: number;
        _id: Id<'repositories'>;
        accessToken: string;
        cloneUrl: string;
        commitSha?: string;
        description: string;
        hooksUrl: string;
        isEnabled: boolean;
        isPrivate: boolean;
        language: string;
        lastSyncedAt: string;
        mainBranch: string;
        name: string;
        provider: string;
        repositoryId: number;
        repositoryName: string;
        settings: {
          addComments: boolean;
          autoReview: boolean;
          notifyOnCompletion: boolean;
        };
        sshUrl: string;
        status?: 'pending' | 'started' | 'completed' | 'failed' | 'indexed';
        updatedAt?: string;
        url: string;
        userId: Id<'users'>;
        webhookId?: string;
      }
    >;
    updateLastIndexedCommit: FunctionReference<
      'mutation',
      'public',
      {
        commitSha: string;
        repositoryId: string;
        status: 'pending' | 'started' | 'completed' | 'failed' | 'indexed';
      },
      any
    >;
    updateIndexingStatus: FunctionReference<
      'mutation',
      'public',
      {
        repositoryId: string;
        status: 'pending' | 'started' | 'completed' | 'failed' | 'indexed';
      },
      any
    >;
  };
  reviews: {
    startReviewAnalysis: FunctionReference<
      'mutation',
      'public',
      { pullRequestId: Id<'pullRequests'> },
      any
    >;
    completeReviewAnalysis: FunctionReference<
      'mutation',
      'public',
      { analysisId: Id<'reviewAnalyses'>; score: number; summary: string },
      any
    >;
    failReviewAnalysis: FunctionReference<
      'mutation',
      'public',
      { analysisId: Id<'reviewAnalyses'>; errorMessage: string },
      any
    >;
    addReviewComment: FunctionReference<
      'mutation',
      'public',
      {
        category: string;
        content: string;
        line: number;
        path: string;
        reviewAnalysisId: Id<'reviewAnalyses'>;
        severity: string;
        suggestedFix?: string;
      },
      any
    >;
    getPullRequestReviews: FunctionReference<
      'query',
      'public',
      { pullRequestId: Id<'pullRequests'> },
      any
    >;
    getReviewComments: FunctionReference<
      'query',
      'public',
      { reviewAnalysisId: Id<'reviewAnalyses'> },
      any
    >;
  };
  users: {
    getUser: FunctionReference<'query', 'public', { clerkId: string }, any>;
    store: FunctionReference<'mutation', 'public', Record<string, never>, any>;
    updateUser: FunctionReference<
      'mutation',
      'public',
      { clerkId: string; email?: string; image?: string; name?: string },
      any
    >;
  };
  github: {
    updateRepositorySettings: FunctionReference<
      'mutation',
      'public',
      {
        repositoryId: Id<'repositories'>;
        settings: {
          addComments?: boolean;
          autoReview?: boolean;
          notifyOnCompletion?: boolean;
        };
      },
      any
    >;
    toggleRepositoryEnabled: FunctionReference<
      'mutation',
      'public',
      { repositoryId: Id<'repositories'> },
      any
    >;
    disconnectRepository: FunctionReference<
      'mutation',
      'public',
      { repositoryId: Id<'repositories'> },
      any
    >;
    syncGitHubRepositoryList: FunctionReference<
      'mutation',
      'public',
      { accessToken: string; userId: string },
      any
    >;
    createPullRequestReview: FunctionReference<
      'mutation',
      'public',
      {
        commitSha: string;
        prNumber: number;
        prTitle: string;
        prUrl: string;
        repositoryId: Id<'repositories'>;
      },
      any
    >;
    fetchUserRepositories: FunctionReference<
      'action',
      'public',
      { accessToken: string; page?: number; perPage?: number },
      any
    >;
  };
  embeddings: {
    storeEmbedding: FunctionReference<
      'mutation',
      'public',
      {
        chunkType?: string;
        commitSha: string;
        embedding: Array<number>;
        endLine: number;
        filePath: string;
        language?: string;
        repositoryId: string;
        startLine: number;
        symbolName?: string;
      },
      Id<'codeChunks'>
    >;
    searchSimilarCode: FunctionReference<
      'action',
      'public',
      {
        embedding: Array<number>;
        language?: string;
        limit?: number;
        repositoryId?: Id<'repositories'>;
      },
      any
    >;
    searchLegacyVectors: FunctionReference<
      'action',
      'public',
      {
        embedding: Array<number>;
        language?: string;
        limit?: number;
        repositoryId?: Id<'repositories'>;
      },
      any
    >;
  };
  service: {
    scheduleBackgroundJob: FunctionReference<
      'mutation',
      'public',
      { repositoryId: Id<'repositories'> },
      { message: string; success: boolean }
    >;
  };
};
export type InternalApiType = {};
