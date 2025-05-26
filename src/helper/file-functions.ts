import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';
import OpenAI from 'openai';
import { ConvexHttpClient } from 'convex/browser';
import { createTreeSitterService } from '../services/tree-sitter-service.js';
// import { storeEmbedding } from './embedding.js';
import { generateEmbedding, storeEmbedding } from './embedding.js';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import tsModule from 'tree-sitter-typescript';
import Java from 'tree-sitter-java';
import { createDependencyGraphService } from '../services/dependency-graph-service.js';
import { DependencyGraph } from '../services/dependency-graph-service.js';
import { CodeRelationship, EnhancedCodeChunk } from '../types.js';
import { EmbeddingChunk } from '../types.js';
import { createCodeMetricsService } from '../services/code-metrics-service.js';
import { api } from '../convex/api.js';

// Language modules for tree-sitter
const TypeScript = tsModule.typescript;
const TSX = tsModule.tsx;

// Map of language IDs to their tree-sitter language modules
const LANGUAGE_MODULES: Record<string, any> = {
  javascript: JavaScript,
  typescript: TypeScript,
  tsx: TSX,
  java: Java,
};

// Map language IDs to their normalized form
function mapLanguageId(languageId: string): string {
  // Normalize language ID
  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
  };

  return languageMap[languageId] || languageId;
}

// File-related helper functions (moved directly into the handler)
export async function getAllFilesRecursive(dir: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      return dirent.isDirectory() ? getAllFilesRecursive(res) : res;
    })
  );
  return files.flat();
}

const IGNORE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.tiff',
  '.ico',
  '.svg',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.ogg',
  '.wav',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.exe',
  '.dll',
  '.so',
  '.o',
  '.obj',
  '.class',
];

const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.vercel',
  '.github',
  '.vscode',
  'coverage',
  '.cache',
];

export function shouldProcessFile(filePath: string): boolean {
  // Skip files with ignored extensions
  const extension = path.extname(filePath).toLowerCase();
  if (IGNORE_EXTENSIONS.includes(extension)) {
    return false;
  }

  // Skip files in ignored directories
  const pathParts = filePath.split(path.sep);
  for (const dir of IGNORE_DIRS) {
    if (pathParts.includes(dir)) {
      return false;
    }
  }

  return true;
}

// Function to process files and generate embeddings
export async function processFiles(
  cloneDir: string,
  filesToProcess: string[],
  repoId: string,
  commitSha: string,
  openai: OpenAI,
  treeSitterService: ReturnType<typeof createTreeSitterService>,
  convexClient: ConvexHttpClient
): Promise<string[]> {
  const processedFiles: string[] = [];
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB

  logger.info(`Processing files`, { count: filesToProcess.length });

  // Process in batches to avoid memory issues
  const BATCH_SIZE = 20;
  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);
    // Process files in parallel for each batch
    await Promise.all(
      batch.map(async (fullFilePath) => {
        try {
          // Check file size
          const stats = await fs.stat(fullFilePath).catch(() => null);
          if (!stats || !stats.isFile() || stats.size > MAX_FILE_SIZE) {
            if (stats && stats.size > MAX_FILE_SIZE) {
              logger.debug(`Skipping large file`, { filePath: fullFilePath, size: stats.size });
            }
            return;
          }

          // Read file content
          const content = await fs.readFile(fullFilePath, 'utf8');

          // Get file extension and determine language
          const relativePath = path.relative(cloneDir, fullFilePath);
          const extension = path.extname(relativePath).toLowerCase().slice(1);
          const language = extension || 'txt';

          logger.info(`Processing file`, { path: relativePath });

          // Parse file into chunks using TreeSitter
          const chunks = treeSitterService.parseCodeToChunks(content, language, fullFilePath);

          // Set up the parser to get the AST for relationship extraction
          const parser = new Parser();
          const languageMapped = mapLanguageId(language);
          const langModule = LANGUAGE_MODULES[languageMapped];

          if (!langModule) {
            logger.debug(
              `No language module found for: ${language}, skipping relationship extraction`
            );
            return { chunks, relationships: [] };
          }

          parser.setLanguage(langModule);
          const tree = parser.parse(content);

          // Extract code relationships for dependency analysis
          const relationships = treeSitterService.extractCodeRelationships(
            tree,
            content,
            relativePath,
            language
          );
          storeCodeRelationships(relationships, repoId, commitSha, convexClient);
          logger.debug(`Processed ${relativePath}`, {
            language,
            chunkCount: chunks.length,
            relationshipCount: relationships.length,
          });

          const dependencyGraphService = createDependencyGraphService();

          // Build a temporary dependency graph just for this file
          const graph = await dependencyGraphService.getDependencyGraph(
            `temp_${repoId}_${relativePath}`,
            async () => relationships
          );
          // Enhance the chunks with semantic context
          const enhancedChunks = await createEnhancedChunks(chunks, repoId, cloneDir, graph);
          // Process each chunk
          for (const chunk of enhancedChunks) {
            // Generate embedding (using pre-initialized openai client)
            const embedding = await generateEmbedding(chunk.codeChunkText, openai, relativePath);

            logger.debug('embedding ----->', { embedding });
            logger.debug('chunk ----->', { chunk });

            // Skip if embedding couldn't be generated
            if (!embedding) {
              continue;
            }
            // Store embedding with enhanced metadata (using passed convex client)
            await storeEmbedding(
              chunk,
              embedding[0].embedding,
              relativePath,
              repoId,
              commitSha,
              convexClient
            );
          }
          processedFiles.push(relativePath);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to process file`, {
            path: fullFilePath,
            error: errorMessage,
          });
        }
      })
    );
  }

  return processedFiles;
}

/**
 * Create semantically enhanced code chunks with additional metadata
 */
async function createEnhancedChunks(
  chunks: EmbeddingChunk[],
  repositoryId: string,
  repositoryPath: string,
  dependencyGraph: DependencyGraph
): Promise<EnhancedCodeChunk[]> {
  logger.debug('Enhancing chunks with semantic metadata', {
    chunkCount: chunks.length,
    repositoryId,
  });

  const codeMetricsService = createCodeMetricsService();
  const dependencyGraphService = createDependencyGraphService();
  return Promise.all(
    chunks.map(async (chunk) => {
      // Skip chunks without symbol names (like imports)
      if (
        !chunk.symbolName &&
        chunk.chunkType !== 'class' &&
        chunk.chunkType !== 'function' &&
        chunk.chunkType !== 'method'
      ) {
        // For chunks without symbols, return a simplified enhancement
        return {
          ...chunk,
          metadata: {
            dependencies: [],
            dependents: [],
            semanticType: codeMetricsService.detectSemanticType(chunk),
            complexity: {
              cyclomaticComplexity: 1,
              cognitiveComplexity: 1,
              linesOfCode: chunk.codeChunkText.split('\n').length,
              dependencyCount: 0,
              dependentCount: 0,
            },
            changeFrequency: 0.1,
            tags: [],
          },
        };
      }

      // For chunks with symbols, calculate dependencies and dependents
      const dependencies = dependencyGraph
        ? dependencyGraphService
            .findDependenciesWithDepth(
              dependencyGraph,
              chunk.symbolName ? chunk.symbolName : '',
              null,
              2
            )
            .map((node) => node.symbolName || '')
        : [];

      const dependents = dependencyGraph
        ? dependencyGraphService
            .findDependentsWithDepth(
              dependencyGraph,
              chunk.symbolName ? chunk.symbolName : '',
              null,
              2
            )
            .map((node) => node.symbolName || '')
        : [];

      // Filter out empty symbol names
      const filteredDependencies = dependencies.filter(Boolean);
      const filteredDependents = dependents.filter(Boolean);

      // Use the code metrics service to enhance the chunk
      return codeMetricsService.enhanceChunk(
        chunk,
        filteredDependencies,
        filteredDependents,
        repositoryPath
      );
    })
  );
}

/**
 * Store code relationships in the database
 */
async function storeCodeRelationships(
  relationships: CodeRelationship[],
  repositoryId: string,
  commitSha: string,
  convex: ConvexHttpClient
): Promise<void> {
  try {
    // For now, just log the relationships
    logger.debug(`Would store ${relationships.length} code relationships`, {
      repositoryId,
      commitSha,
    });
    relationships.forEach(async (relationship) => {
      await convex.mutation(api.embeddings.storeCodeRelationship, {
        repositoryId,
        commitSha,
        metadata: {
          endLine: relationship.location.endLine,
          filePath: relationship.location.filePath,
          startLine: relationship.location.startLine,
        },
        relationshipType: relationship.type,
        source: relationship.source,
        target: relationship.target,
      });
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to store code relationships', { error: errorMsg });
  }
}
