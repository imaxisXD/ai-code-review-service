import { CodeRelationship } from '../types.js';
import { createDependencyGraphService } from './dependency-graph-service.js';
import { ConvexHttpClient } from '../utils/convex-http-client.js';
import { logger } from '../utils/logger.js';

// Interface for code context, which represents a piece of code with its metadata
export interface CodeContext {
  code: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  chunkType?: string;
  relevanceReason: string;
  metadata?: {
    semanticType?: string;
    complexity?: number;
    changeFrequency?: number;
    dependencies?: string[];
    dependents?: string[];
    tags?: string[];
  };
}

// Interface for file diffs
export interface FileDiff {
  filePath: string;
  hunks: {
    oldStart: number;
    newStart: number;
    oldLines: number;
    newLines: number;
    content: string;
  }[];
}

/**
 * Creates a service for retrieving multi-level context for code review
 */
export function createContextRetrievalService(convexClient: ConvexHttpClient) {
  const dependencyGraphService = createDependencyGraphService();

  /**
   * Fetch actual code content from the repository
   * This is the ONLY function that should retrieve actual code content
   */
  async function fetchCodeFromRepository(
    repositoryId: string,
    filePath: string,
    startLine: number,
    endLine: number,
    commitSha: string
  ): Promise<string | null> {
    try {
      // Use the Convex client to fetch code from the repository at runtime
      // This ensures we never store actual code in our database
      const result = await convexClient.query('repository:getFileContent', {
        repositoryId,
        filePath,
        startLine,
        endLine,
        commitSha,
      });

      return result.content;
    } catch (error) {
      logger.error('Error fetching code from repository', {
        filePath,
        startLine,
        endLine,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get context for changes in a pull request
   */
  async function getContextForChanges(
    repositoryId: string,
    changedFiles: string[],
    diffs: FileDiff[],
    commitSha: string
  ): Promise<CodeContext[]> {
    logger.info('Getting context for changes', {
      repositoryId,
      changedFilesCount: changedFiles.length,
      diffsCount: diffs.length,
    });

    // First level: Direct changes
    const directChanges = extractDirectChanges(diffs);
    logger.debug('Extracted direct changes', { count: directChanges.length });

    // Second level: Affected symbols (AST-based)
    const affectedSymbols = await getAffectedSymbols(directChanges, repositoryId, commitSha);
    logger.debug('Found affected symbols', { count: affectedSymbols.length });

    // Third level: Dependency graph traversal
    const relatedSymbols = await getRelatedSymbols(affectedSymbols, repositoryId, commitSha);
    logger.debug('Found related symbols', { count: relatedSymbols.length });

    // Fourth level: Semantic similarity search
    const semanticallySimilarCode = await getSemanticallyRelatedCode(
      repositoryId,
      [...directChanges, ...affectedSymbols],
      commitSha
    );
    logger.debug('Found semantically similar code', { count: semanticallySimilarCode.length });

    // Combine and prioritize all context
    const combinedContext = combineAndPrioritizeContext([
      { level: 1, context: directChanges },
      { level: 2, context: affectedSymbols },
      { level: 3, context: relatedSymbols },
      { level: 4, context: semanticallySimilarCode },
    ]);

    logger.info('Combined and prioritized context', { count: combinedContext.length });
    return combinedContext;
  }

  /**
   * Extract direct changes from file diffs
   * Note: This is safe because diffs come directly from the PR, not the database
   */
  function extractDirectChanges(diffs: FileDiff[]): CodeContext[] {
    return diffs.flatMap((diff) => {
      return diff.hunks.map((hunk) => {
        return {
          code: hunk.content,
          filePath: diff.filePath,
          startLine: hunk.newStart,
          endLine: hunk.newStart + hunk.newLines - 1,
          relevanceReason: 'Direct change in PR',
          metadata: {
            changeFrequency: 1.0, // Just changed, so highest frequency
          },
        };
      });
    });
  }

  /**
   * Get symbols that are affected by the changes
   */
  async function getAffectedSymbols(
    changes: CodeContext[],
    repositoryId: string,
    commitSha: string
  ): Promise<CodeContext[]> {
    // Find symbols that contain the changed lines
    const affectedSymbols: CodeContext[] = [];

    for (const change of changes) {
      try {
        // Find enhanced chunk METADATA that contain this change
        // This only retrieves metadata, not actual code content
        const chunkMetadata = await convexClient.query(
          'embeddings:getEnhancedChunkMetadataForFile',
          {
            repositoryId,
            filePath: change.filePath,
            commitSha,
          }
        );

        // Filter chunks that overlap with the change
        const overlappingChunks = chunkMetadata.filter((chunk: any) => {
          return (
            chunk.startLine <= change.endLine &&
            chunk.endLine >= change.startLine &&
            chunk.symbolName
          );
        });

        // Convert to CodeContext format and fetch code content
        for (const chunk of overlappingChunks) {
          // Fetch the actual code content from the repository
          const codeContent = await fetchCodeFromRepository(
            repositoryId,
            chunk.filePath,
            chunk.startLine,
            chunk.endLine,
            commitSha
          );

          if (codeContent) {
            affectedSymbols.push({
              code: codeContent,
              filePath: chunk.filePath,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              symbolName: chunk.symbolName,
              chunkType: chunk.chunkType,
              relevanceReason: `Symbol containing changed code (${chunk.symbolName})`,
              metadata: {
                semanticType: chunk.metadata.semanticType,
                complexity: chunk.metadata.complexity.cyclomaticComplexity,
                changeFrequency: chunk.metadata.changeFrequency,
                dependencies: chunk.metadata.dependencies,
                dependents: chunk.metadata.dependents,
                tags: chunk.metadata.tags,
              },
            });
          }
        }
      } catch (error) {
        logger.error('Error finding affected symbols', {
          filePath: change.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return affectedSymbols;
  }

  /**
   * Get symbols that are related to the affected symbols through the dependency graph
   */
  async function getRelatedSymbols(
    symbols: CodeContext[],
    repositoryId: string,
    commitSha: string
  ): Promise<CodeContext[]> {
    const relatedSymbols: CodeContext[] = [];

    // Get dependency relationships
    const allRelationships = await fetchRepositoryRelationships(repositoryId, commitSha);

    // Build a temporary dependency graph from these relationships
    const graph = await dependencyGraphService.getDependencyGraph(
      `temp_retrieval_${repositoryId}_${commitSha}`,
      async () => allRelationships
    );

    // For each symbol, find its direct dependencies and dependents
    for (const symbol of symbols) {
      if (!symbol.symbolName) continue;

      try {
        // Get dependencies with depth limit of 1 (just direct dependencies)
        const dependencies = dependencyGraphService.findDependenciesWithDepth(
          graph,
          symbol.filePath,
          symbol.symbolName,
          1
        );

        // Get dependents with depth limit of 1 (just direct dependents)
        const dependents = dependencyGraphService.findDependentsWithDepth(
          graph,
          symbol.filePath,
          symbol.symbolName,
          1
        );

        // Fetch the actual code for these symbols
        for (const dep of [...dependencies, ...dependents]) {
          if (!dep.symbolName) continue;

          // Get the chunk metadata for this symbol - NOT the code content
          const symbolMetadata = await convexClient.query('embeddings:getSymbolMetadata', {
            repositoryId,
            filePath: dep.filePath,
            symbolName: dep.symbolName,
            commitSha,
          });

          if (symbolMetadata) {
            // Fetch actual code from repository
            const codeContent = await fetchCodeFromRepository(
              repositoryId,
              dep.filePath,
              symbolMetadata.startLine,
              symbolMetadata.endLine,
              commitSha
            );

            if (codeContent) {
              relatedSymbols.push({
                code: codeContent,
                filePath: dep.filePath,
                startLine: symbolMetadata.startLine,
                endLine: symbolMetadata.endLine,
                symbolName: dep.symbolName,
                chunkType: symbolMetadata.chunkType,
                relevanceReason: dependencies.includes(dep)
                  ? `Dependency of ${symbol.symbolName}`
                  : `Dependent of ${symbol.symbolName}`,
                metadata: {
                  semanticType: symbolMetadata.semanticType,
                  complexity: symbolMetadata.complexity?.cyclomaticComplexity,
                  changeFrequency: symbolMetadata.changeFrequency,
                  dependencies: symbolMetadata.dependencies,
                  dependents: symbolMetadata.dependents,
                  tags: symbolMetadata.tags,
                },
              });
            }
          }
        }
      } catch (error) {
        logger.error('Error finding related symbols', {
          symbol: symbol.symbolName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return relatedSymbols;
  }

  /**
   * Get semantically related code using embedding similarity search
   */
  async function getSemanticallyRelatedCode(
    repositoryId: string,
    context: CodeContext[],
    commitSha: string
  ): Promise<CodeContext[]> {
    const relatedCode: CodeContext[] = [];

    // We have key pieces (up to 5) to use as query code
    const queryPieces = context.slice(0, 5);

    // For each piece, find semantically similar code
    for (const piece of queryPieces) {
      try {
        if (!piece.code.trim()) continue;

        // Use the semantic search endpoint - this should ONLY return metadata and locations
        // NOT the actual code content
        const similarCodeLocations = await convexClient.query(
          'embeddings:searchSemanticSimilarity',
          {
            repositoryId,
            query: piece.code,
            // Optionally filter by semantic type if the piece has one
            semanticType: piece.metadata?.semanticType,
          }
        );

        // For each match, fetch the actual code from the repository
        for (const match of similarCodeLocations) {
          // Skip if it's the same code piece
          if (
            match.filePath === piece.filePath &&
            match.startLine === piece.startLine &&
            match.endLine === piece.endLine
          ) {
            continue;
          }

          // Fetch the actual code content from the repository using file path and line numbers
          const codeContent = await fetchCodeFromRepository(
            repositoryId,
            match.filePath,
            match.startLine,
            match.endLine,
            commitSha
          );

          // Only add if we successfully retrieved the code
          if (codeContent) {
            relatedCode.push({
              code: codeContent,
              filePath: match.filePath,
              startLine: match.startLine,
              endLine: match.endLine,
              symbolName: match.symbolName,
              chunkType: match.chunkType,
              relevanceReason: `Semantically similar to code in ${piece.filePath}`,
              metadata: {
                semanticType: match.metadata.semanticType,
                complexity: match.metadata.complexity?.cyclomaticComplexity,
                changeFrequency: match.metadata.changeFrequency,
                tags: match.metadata.tags,
              },
            });
          }
        }
      } catch (error) {
        logger.error('Error finding semantically related code', {
          filePath: piece.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return relatedCode;
  }

  /**
   * Fetch relationships from the repository
   */
  async function fetchRepositoryRelationships(
    repositoryId: string,
    commitSha: string
  ): Promise<CodeRelationship[]> {
    try {
      return await convexClient.query('relationships:getRelationships', {
        repositoryId,
        commitSha,
      });
    } catch (error) {
      logger.error('Error fetching repository relationships', {
        repositoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Combine and prioritize context from different levels
   */
  function combineAndPrioritizeContext(
    leveledContext: { level: number; context: CodeContext[] }[]
  ): CodeContext[] {
    // Flatten all contexts
    const allContext = leveledContext.flatMap((lc) => lc.context);

    // Create a map of contexts to their levels for scoring
    const contextLevelMap = new Map<string, number>();
    leveledContext.forEach(({ level, context }) => {
      context.forEach((ctx) => {
        const key = `${ctx.filePath}:${ctx.startLine}:${ctx.endLine}`;
        // If a context appears in multiple levels, keep the lowest (highest priority)
        if (!contextLevelMap.has(key) || contextLevelMap.get(key)! > level) {
          contextLevelMap.set(key, level);
        }
      });
    });

    // Deduplicate contexts (prefer ones from higher priority levels)
    const deduplicated = deduplicateContext(allContext);

    // Score each context
    const scored = deduplicated.map((ctx) => {
      const key = `${ctx.filePath}:${ctx.startLine}:${ctx.endLine}`;
      const level = contextLevelMap.get(key) || 5; // Default to lowest priority
      const score = calculateContextScore(ctx, level);
      return {
        ...ctx,
        score,
      };
    });

    // Sort by score (descending) and remove the score property
    return scored
      .sort((a, b) => b.score - a.score)
      .map((item) => ({
        code: item.code,
        filePath: item.filePath,
        startLine: item.startLine,
        endLine: item.endLine,
        symbolName: item.symbolName,
        chunkType: item.chunkType,
        relevanceReason: item.relevanceReason,
        metadata: item.metadata,
      }));
  }

  /**
   * Remove duplicate contexts, preferring those with more metadata
   */
  function deduplicateContext(contexts: CodeContext[]): CodeContext[] {
    const uniqueContexts = new Map<string, CodeContext>();

    for (const ctx of contexts) {
      const key = `${ctx.filePath}:${ctx.startLine}:${ctx.endLine}`;

      if (!uniqueContexts.has(key)) {
        uniqueContexts.set(key, ctx);
      } else {
        const existing = uniqueContexts.get(key)!;

        // Prefer the one with more metadata or with a symbol name
        const existingMetadataCount = countMetadataFields(existing.metadata);
        const newMetadataCount = countMetadataFields(ctx.metadata);

        if (newMetadataCount > existingMetadataCount || (ctx.symbolName && !existing.symbolName)) {
          uniqueContexts.set(key, ctx);
        }

        // Combine relevance reasons if they're different
        if (existing.relevanceReason !== ctx.relevanceReason) {
          const combined = uniqueContexts.get(key)!;
          combined.relevanceReason = `${combined.relevanceReason}; ${ctx.relevanceReason}`;
          uniqueContexts.set(key, combined);
        }
      }
    }

    return Array.from(uniqueContexts.values());
  }

  /**
   * Count the number of metadata fields that have values
   */
  function countMetadataFields(metadata?: Record<string, any>): number {
    if (!metadata) return 0;
    return Object.values(metadata).filter(Boolean).length;
  }

  /**
   * Calculate a relevance score for a context
   */
  function calculateContextScore(ctx: CodeContext, level: number): number {
    let score = 100 - level * 20; // Base score by level (80, 60, 40, 20)

    // Boost score based on metadata
    if (ctx.metadata) {
      // Higher complexity means more important context
      if (ctx.metadata.complexity) {
        score += Math.min(ctx.metadata.complexity, 10); // Max +10 points
      }

      // Higher change frequency means more important context
      if (ctx.metadata.changeFrequency) {
        score += ctx.metadata.changeFrequency * 10; // Max +10 points
      }

      // More dependents means more critical code
      if (ctx.metadata.dependents?.length) {
        score += Math.min(ctx.metadata.dependents.length * 2, 10); // Max +10 points
      }
    }

    // Boost for certain chunk types
    if (ctx.chunkType === 'function' || ctx.chunkType === 'method') {
      score += 5;
    } else if (ctx.chunkType === 'class') {
      score += 7;
    }

    return score;
  }

  return {
    getContextForChanges,
    extractDirectChanges,
    getAffectedSymbols,
    getRelatedSymbols,
    getSemanticallyRelatedCode,
    combineAndPrioritizeContext,
  };
}
