/* eslint-disable @typescript-eslint/no-empty-object-type */
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
    getUserById: FunctionReference<'query', 'public', { userId: Id<'users'> }, any>;
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
        metadata?: any;
        repositoryId: string;
        startLine: number;
        symbolName?: string;
        text?: string;
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
    deleteEmbeddingsByPathBatch: FunctionReference<
      'mutation',
      'public',
      { filePaths: Array<string>; repositoryId: string },
      { deletedCount: number; message: string; success: boolean }
    >;
    storeCodeRelationship: FunctionReference<
      'mutation',
      'public',
      {
        commitSha: string;
        metadata: { endLine: number; filePath: string; startLine: number };
        relationshipType:
          | 'function_call'
          | 'import'
          | 'inheritance'
          | 'implementation'
          | 'usage'
          | 'composition';
        repositoryId: string;
        source: string;
        target: string;
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
    storeJobResult: FunctionReference<
      'mutation',
      'public',
      {
        commentsPosted?: number;
        error?: string;
        jobId: string;
        reviewId?: string;
        status: 'Success' | 'Failed';
        ttlMinutes?: number;
      },
      Id<'jobDeduplication'>
    >;
  };
  llm: {
    searchCode: FunctionReference<
      'action',
      'public',
      {
        language?: string;
        limit?: number;
        query: string;
        repositoryId?: Id<'repositories'>;
      },
      any
    >;
    searchAndAnalyzeCode: FunctionReference<
      'action',
      'public',
      {
        language?: string;
        limit?: number;
        prompt?: string;
        query: string;
        repositoryId?: Id<'repositories'>;
      },
      any
    >;
  };
  syncuserdatatosocialprovider: {
    getUserDetailsFromGitHub: FunctionReference<'action', 'public', { userId: Id<'users'> }, null>;
  };
  installations: {
    getInstallation: FunctionReference<
      'query',
      'public',
      { installationId: number },
      {
        _creationTime: number;
        _id: Id<'installations'>;
        accountId: number;
        accountLogin: string;
        accountType: 'User' | 'Organization';
        appId: number;
        createdAt: number;
        events: Array<string>;
        installationId: number;
        permissions: any;
        targetType: 'User' | 'Organization';
        updatedAt: number;
      } | null
    >;
  };
  jobs: {
    checkJobDeduplication: FunctionReference<
      'query',
      'public',
      { jobId: string },
      {
        _id: Id<'jobDeduplication'>;
        commentsPosted?: number;
        commitSha: string;
        error?: string;
        expiresAt: number;
        jobId: string;
        jobType: 'pr_review' | 'indexing';
        prNumber?: number;
        processedAt: number;
        repositoryId: string;
        result: any;
        reviewId?: string;
        status: 'Success' | 'Failed';
      } | null
    >;
    storeJobResult: FunctionReference<
      'mutation',
      'public',
      {
        commentsPosted?: number;
        commitSha?: string;
        error?: string;
        jobId: string;
        jobType?: 'pr_review' | 'indexing';
        prNumber?: number;
        repositoryId?: string;
        result?: any;
        reviewId?: string;
        status: 'Success' | 'Failed';
        ttlMinutes?: number;
      },
      Id<'jobDeduplication'>
    >;
  };
};
export type InternalApiType = {};
