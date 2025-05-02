import { logger } from '../utils/logger.js';
import { EmbeddingChunk, ChunkType } from '../types.js';
import Parser from 'tree-sitter'; // Use native tree-sitter
import type { SyntaxNode, Tree, Language, Query } from 'tree-sitter'; // Import types
import JavaScript from 'tree-sitter-javascript';
import tsModule from 'tree-sitter-typescript';
const TypeScript: Language = tsModule.typescript as Language;
const TSX: Language = tsModule.tsx as Language;
import Java from 'tree-sitter-java';

// Map of language IDs to their tree-sitter language modules
const LANGUAGE_MODULES: Record<string, Language> = {
  javascript: JavaScript as Language,
  typescript: TypeScript,
  tsx: TSX,
  java: Java as Language,
};

// Cache for compiled queries to improve performance
type QueryCache = Record<string, Query>;

/**
 * Map language IDs to the keys used in LANGUAGE_MODULES
 */
function mapLanguageId(languageId: string): string {
  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'tsx',
  };
  return languageMap[languageId] || languageId;
}

/**
 * Get a language module by ID
 */
function getLanguageModule(languageId: string): Language | null {
  const mapped = mapLanguageId(languageId);
  return LANGUAGE_MODULES[mapped] || null;
}

/**
 * Get the appropriate import query for a language
 */
function getImportQuery(language: string): string | null {
  const importQueries: Record<string, string> = {
    javascript: '(import_statement) @import',
    typescript: '(import_statement) @import',
    tsx: '(import_statement) @import',
    java: '(import_declaration) @import',
  };
  return importQueries[mapLanguageId(language)] || null;
}

/**
 * Get the appropriate chunk type for imports
 */
function getImportChunkType(language: string): ChunkType {
  // Map languages with non-standard import mechanisms
  const mappedLanguage = mapLanguageId(language);

  switch (mappedLanguage) {
    case 'ruby':
      return 'require';
    case 'rust':
      return 'use';
    case 'csharp':
      return 'using';
    case 'cpp':
      return 'namespace';
    default:
      return 'import';
  }
}

/**
 * Check if a string value is a valid symbol chunk type
 */
function isSymbolChunkType(
  value: string
): value is Extract<
  ChunkType,
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'property'
  | 'arrow_function'
  | 'module'
  | 'component'
  | 'trait'
> {
  return [
    'class',
    'function',
    'method',
    'interface',
    'type',
    'enum',
    'struct',
    'property',
    'arrow_function',
    'module',
    'component',
    'trait',
  ].includes(value);
}

/**
 * Map capture name to chunk type
 */
function mapCaptureToChunkType(captureName: string): ChunkType {
  // Map capture names to ChunkType values
  if (isSymbolChunkType(captureName)) {
    return captureName;
  }
  return 'code';
}

/**
 * Create tree-sitter service functions
 */
export function createTreeSitterService() {
  const parser = new Parser();
  const queryCache: QueryCache = {};

  logger.info('TreeSitter service initialized (using native bindings)');

  /**
   * Get a cached query or create and cache a new one
   */
  function getOrCreateQuery(language: Language, queryString: string): Query {
    const cacheKey = `${language.name}:${queryString}`;

    if (!queryCache[cacheKey]) {
      try {
        // Create a new query using the language's query method
        const query = new Parser.Query(language, queryString);
        queryCache[cacheKey] = query;
      } catch (error) {
        logger.error('Failed to create query', { language: language.name, error });
        throw error;
      }
    }

    return queryCache[cacheKey];
  }

  /**
   * Extract symbol name from a node
   */
  function extractSymbolName(node: SyntaxNode, captureName: string): string | null {
    try {
      let nameNode: SyntaxNode | null = null;

      if (['class', 'interface', 'function', 'method', 'enum', 'component'].includes(captureName)) {
        nameNode = node.childForFieldName('name');
      } else if (captureName === 'type') {
        nameNode = node.childForFieldName('name');
      } else if (captureName === 'arrow_function') {
        const parent = node.parent;
        if (parent && parent.type === 'variable_declarator') {
          nameNode = parent.childForFieldName('name');
        }
      }

      return nameNode ? nameNode.text : null;
    } catch (error) {
      logger.debug('Error extracting symbol name', { error, nodeType: node.type });
      return null;
    }
  }

  /**
   * Get the appropriate symbol query for a language
   */
  function getSymbolQuery(language: string): string | null {
    const symbolQueries: Record<string, string> = {
      javascript: `
        (class_declaration) @class
        (function_declaration) @function
        (method_definition) @method
        (arrow_function) @arrow_function
        (export_statement 
          (function_declaration) @function)
        (export_statement 
          (class_declaration) @class)
      `,
      typescript: `
        (class_declaration) @class
        (function_declaration) @function
        (method_definition) @method
        (arrow_function) @arrow_function
        (interface_declaration) @interface
        (type_alias_declaration) @type
        (enum_declaration) @enum
        (export_statement 
          (function_declaration) @function)
        (export_statement 
          (class_declaration) @class)
        (export_statement 
          (interface_declaration) @interface)
        (export_statement 
          (type_alias_declaration) @type)
        (export_statement 
          (enum_declaration) @enum)
      `,
      tsx: `
        (class_declaration) @class
        (function_declaration) @function
        (method_definition) @method
        (arrow_function) @arrow_function
        (interface_declaration) @interface
        (type_alias_declaration) @type
        (enum_declaration) @enum
        (jsx_element) @component
        (export_statement 
          (function_declaration) @function)
        (export_statement 
          (class_declaration) @class)
        (export_statement 
          (interface_declaration) @interface)
        (export_statement 
          (type_alias_declaration) @type)
        (export_statement 
          (enum_declaration) @enum)
      `,
      java: `
        (class_declaration) @class
        (method_declaration) @method
        (interface_declaration) @interface
        (enum_declaration) @enum
      `,
    };
    return symbolQueries[mapLanguageId(language)] || null;
  }

  /**
   * Extract import chunks from AST
   */
  function extractImportChunks(
    rootNode: SyntaxNode,
    code: string,
    language: string,
    chunks: EmbeddingChunk[],
    langModule: Language
  ): void {
    const queryImports = getImportQuery(language);
    if (!queryImports) return;

    try {
      const query = getOrCreateQuery(langModule, queryImports);
      const captures = query.captures(rootNode);

      for (const { node } of captures) {
        if (node.endIndex - node.startIndex < 5) continue;

        const text = code.substring(node.startIndex, node.endIndex);
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const chunkType = getImportChunkType(language);

        chunks.push({
          codeChunkText: text,
          startLine,
          endLine,
          language,
          chunkType,
          symbolName: null,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed during import chunk query execution', {
        language,
        query: queryImports,
        error: errorMsg,
      });
    }
  }

  /**
   * Extract symbol declarations (classes, functions, etc.) from AST
   */
  function extractSymbolDeclarations(
    rootNode: SyntaxNode,
    code: string,
    language: string,
    chunks: EmbeddingChunk[],
    langModule: Language
  ): void {
    const querySymbols = getSymbolQuery(language);
    if (!querySymbols) return;

    try {
      const query = getOrCreateQuery(langModule, querySymbols);
      const captures = query.captures(rootNode);

      for (const { node, name } of captures) {
        if (node.endIndex - node.startIndex < 5) continue;

        const text = code.substring(node.startIndex, node.endIndex);
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const chunkType = mapCaptureToChunkType(name);
        const symbolName = extractSymbolName(node, name);

        chunks.push({
          codeChunkText: text,
          startLine,
          endLine,
          language,
          chunkType,
          symbolName,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed during symbol declaration chunk query execution', {
        language,
        error: errorMsg,
      });
    }
  }

  /**
   * Extract chunks from the AST
   */
  function extractChunksFromTree(
    tree: Tree,
    code: string,
    language: string,
    langModule: Language
  ): EmbeddingChunk[] {
    const chunks: EmbeddingChunk[] = [];
    const rootNode: SyntaxNode = tree.rootNode;

    extractImportChunks(rootNode, code, language, chunks, langModule);
    extractSymbolDeclarations(rootNode, code, language, chunks, langModule);

    return chunks;
  }

  /**
   * Parse code generically without language-specific AST
   */
  function parseGenericCode(code: string, language: string): EmbeddingChunk[] {
    const lines = code.split('\n');
    const chunks: EmbeddingChunk[] = [];
    const MAX_LINES_PER_CHUNK = 50;

    // Create chunks from the code, each with at most MAX_LINES_PER_CHUNK lines
    for (let startLine = 0; startLine < lines.length; startLine += MAX_LINES_PER_CHUNK) {
      const endLine = Math.min(startLine + MAX_LINES_PER_CHUNK, lines.length);
      const chunkLines = lines.slice(startLine, endLine);
      const chunkText = chunkLines.join('\n');

      if (chunkText.trim().length === 0) continue;

      chunks.push({
        codeChunkText: chunkText,
        startLine: startLine + 1, // 1-indexed
        endLine: endLine, // 1-indexed
        language,
        chunkType: 'code',
        symbolName: null,
      });
    }

    return chunks;
  }

  /**
   * Parse code into an AST and extract meaningful code chunks
   */
  function parseCodeToChunks(
    code: string,
    language: string,
    filePath: string,
    previousTree?: Tree
  ): EmbeddingChunk[] {
    try {
      logger.debug('Processing file with TreeSitter', { filePath, language });

      const langModule = getLanguageModule(language);
      if (!langModule) {
        logger.debug(`No language module found for: ${language}, falling back to generic chunking`);
        return parseGenericCode(code, language);
      }

      parser.setLanguage(langModule);

      // Use incremental parsing if a previous tree is provided
      const tree = previousTree ? parser.parse(code, previousTree) : parser.parse(code);

      const chunks = extractChunksFromTree(tree, code, language, langModule);

      if (chunks.length > 0) {
        logger.debug(`Extracted ${chunks.length} chunks from ${filePath}`);
        return chunks;
      }

      logger.debug(
        `No specific chunks found for ${language} in ${filePath}, using generic chunking.`
      );
      return parseGenericCode(code, language);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to parse code with TreeSitter', {
        language,
        filePath,
        error: errorMsg,
      });
      return parseGenericCode(code, language);
    }
  }

  /**
   * Incrementally update an existing tree after edits
   * This is more efficient for small changes than full re-parsing
   */
  function updateTree(
    oldTree: Tree,
    newCode: string,
    startIndex: number,
    oldEndIndex: number,
    newEndIndex: number,
    startPosition: { row: number; column: number },
    oldEndPosition: { row: number; column: number },
    newEndPosition: { row: number; column: number }
  ): Tree {
    try {
      oldTree.edit({
        startIndex,
        oldEndIndex,
        newEndIndex,
        startPosition,
        oldEndPosition,
        newEndPosition,
      });

      return parser.parse(newCode, oldTree);
    } catch (error) {
      logger.error('Failed to incrementally update tree', { error });
      // Fall back to full parse if incremental update fails
      return parser.parse(newCode);
    }
  }

  return {
    parseCodeToChunks,
    updateTree,
  };
}
