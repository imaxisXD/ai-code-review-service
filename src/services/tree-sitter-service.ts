/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Logger } from '../utils/logger';
import { EmbeddingChunk, ChunkType } from '../types';
import Parser from 'tree-sitter'; // Use native tree-sitter
import type { SyntaxNode, Tree, Language, Query } from 'tree-sitter'; // Import types

// Import language modules directly (Node.js bindings)
// Using require for TS due to its export structure
import JavaScript from 'tree-sitter-javascript';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tsModule = require('tree-sitter-typescript');
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

interface TreeSitterServiceOptions {
  logger: Logger;
}

/**
 * Service for parsing code using tree-sitter native Node.js bindings
 */
export class TreeSitterService {
  private logger: Logger;
  private parser: Parser;
  private queryCache: QueryCache = {};

  constructor(options: TreeSitterServiceOptions) {
    this.logger = options.logger;
    this.parser = new Parser();
    this.logger.info('TreeSitter service initialized (using native bindings)');
  }

  /**
   * Parse code into an AST and extract meaningful code chunks
   */
  public parseCodeToChunks(
    code: string,
    language: string,
    filePath: string,
    previousTree?: Tree
  ): EmbeddingChunk[] {
    try {
      this.logger.debug('Processing file with TreeSitter', { filePath, language });

      const langModule = this.getLanguageModule(language);
      if (!langModule) {
        this.logger.debug(
          `No language module found for: ${language}, falling back to generic chunking`
        );
        return this.parseGenericCode(code, language);
      }

      this.parser.setLanguage(langModule);

      // Use incremental parsing if a previous tree is provided
      const tree = previousTree ? this.parser.parse(code, previousTree) : this.parser.parse(code);

      const chunks = this.extractChunksFromTree(tree, code, language, langModule);

      if (chunks.length > 0) {
        this.logger.debug(`Extracted ${chunks.length} chunks from ${filePath}`);
        return chunks;
      }

      this.logger.debug(
        `No specific chunks found for ${language} in ${filePath}, using generic chunking.`
      );
      return this.parseGenericCode(code, language);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to parse code with TreeSitter', {
        language,
        filePath,
        error: errorMsg,
      });
      return this.parseGenericCode(code, language);
    }
  }

  /**
   * Incrementally update an existing tree after edits
   * This is more efficient for small changes than full re-parsing
   */
  public updateTree(
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

      return this.parser.parse(newCode, oldTree);
    } catch (error) {
      this.logger.error('Failed to incrementally update tree', { error });
      // Fall back to full parse if incremental update fails
      return this.parser.parse(newCode);
    }
  }

  /**
   * Get a language module by ID
   */
  private getLanguageModule(languageId: string): Language | null {
    const mappedLanguage = this.mapLanguageId(languageId);
    return LANGUAGE_MODULES[mappedLanguage] || null;
  }

  /**
   * Map language IDs to the keys used in LANGUAGE_MODULES
   */
  private mapLanguageId(languageId: string): string {
    const languageMap: Record<string, string> = {
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'tsx',
    };
    return languageMap[languageId] || languageId;
  }

  /**
   * Extract chunks from the AST
   */
  private extractChunksFromTree(
    tree: Tree,
    code: string,
    language: string,
    langModule: Language
  ): EmbeddingChunk[] {
    const chunks: EmbeddingChunk[] = [];
    const rootNode: SyntaxNode = tree.rootNode;

    this.extractImportChunks(rootNode, code, language, chunks, langModule);
    this.extractSymbolDeclarations(rootNode, code, language, chunks, langModule);

    return chunks;
  }

  /**
   * Get a cached query or create and cache a new one
   */
  private getOrCreateQuery(language: Language, queryString: string): Query {
    const cacheKey = `${language.name}:${queryString}`;

    if (!this.queryCache[cacheKey]) {
      try {
        // Create a new query using the language's query method
        const query = new Parser.Query(language, queryString);
        this.queryCache[cacheKey] = query;
      } catch (error) {
        this.logger.error('Failed to create query', { language: language.name, error });
        throw error;
      }
    }

    return this.queryCache[cacheKey];
  }

  /**
   * Extract import chunks from AST
   */
  private extractImportChunks(
    rootNode: SyntaxNode,
    code: string,
    language: string,
    chunks: EmbeddingChunk[],
    langModule: Language
  ): void {
    const queryImports = this.getImportQuery(language);
    if (!queryImports) return;

    try {
      const query = this.getOrCreateQuery(langModule, queryImports);
      const captures = query.captures(rootNode);

      for (const { node } of captures) {
        if (node.endIndex - node.startIndex < 5) continue;

        const text = code.substring(node.startIndex, node.endIndex);
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const chunkType = this.getImportChunkType(language);

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
      this.logger.error('Failed during import chunk query execution', {
        language,
        query: queryImports,
        error: errorMsg,
      });
    }
  }

  /**
   * Get the appropriate import query for a language
   */
  private getImportQuery(language: string): string | null {
    const importQueries: Record<string, string> = {
      javascript: '(import_statement) @import',
      typescript: '(import_statement) @import',
      tsx: '(import_statement) @import',
      java: '(import_declaration) @import',
    };
    return importQueries[this.mapLanguageId(language)] || null;
  }

  /**
   * Get the appropriate chunk type for imports
   */
  private getImportChunkType(_language: string): ChunkType {
    return 'import';
  }

  /**
   * Extract symbol declarations (classes, functions, etc.) from AST
   */
  private extractSymbolDeclarations(
    rootNode: SyntaxNode,
    code: string,
    language: string,
    chunks: EmbeddingChunk[],
    langModule: Language
  ): void {
    const symbolQuery = this.getSymbolQuery(language);
    if (!symbolQuery) return;

    try {
      const query = this.getOrCreateQuery(langModule, symbolQuery);
      const captures = query.captures(rootNode);

      for (const capture of captures) {
        const { node, name } = capture;
        if (node.endIndex - node.startIndex < 10) continue;

        const text = code.substring(node.startIndex, node.endIndex);
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const symbolName = this.extractSymbolName(node, name);
        const chunkType = this.mapCaptureToChunkType(name);

        if (chunkType === 'code' && !symbolName) continue;

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
      this.logger.error('Failed during symbol declaration query execution', {
        language,
        query: symbolQuery,
        error: errorMsg,
      });
    }
  }

  /**
   * Get the appropriate symbol query for a language
   */
  private getSymbolQuery(language: string): string | null {
    switch (language) {
      case 'typescript':
      case 'tsx':
        return `
          (class_declaration name: (type_identifier) @class)
          (interface_declaration name: (type_identifier) @interface)
          (type_alias_declaration name: (type_identifier) @type)
          (enum_declaration name: (identifier) @enum)
          (function_declaration name: (identifier) @function)
          (method_definition name: (property_identifier) @method)
          (export_statement 
            declaration: [
              (class_declaration name: (type_identifier) @class)
              (interface_declaration name: (type_identifier) @interface)
              (type_alias_declaration name: (type_identifier) @type)
              (enum_declaration name: (identifier) @enum)
              (function_declaration name: (identifier) @function)
            ]
          )
        `;

      case 'javascript':
      case 'jsx':
        return `
          (class_declaration name: (identifier) @class)
          (function_declaration name: (identifier) @function)
          (method_definition name: (property_identifier) @method)
          (export_statement 
            declaration: [
              (class_declaration name: (identifier) @class)
              (function_declaration name: (identifier) @function)
            ]
          )
        `;

      case 'java':
        return `
          (class_declaration name: (identifier) @class)
          (method_declaration name: (identifier) @method)
          (interface_declaration name: (identifier) @interface)
        `;

      default:
        return null;
    }
  }

  /**
   * Type guard to check if a string is a valid symbol chunk type
   */
  private isSymbolChunkType(
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
    const symbolCaptures = [
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
    ];
    return symbolCaptures.includes(value);
  }

  /**
   * Map capture name to chunk type
   */
  private mapCaptureToChunkType(captureName: string): ChunkType {
    if (this.isSymbolChunkType(captureName)) {
      return captureName;
    }
    return 'code';
  }

  /**
   * Extract symbol name from node based on common patterns
   */
  private extractSymbolName(node: SyntaxNode, captureName: string): string | null {
    const nameFields = [
      'name',
      'identifier',
      'property_identifier',
      'type_identifier',
      'field_identifier',
      'constant',
    ];

    if (nameFields.includes(captureName)) {
      return node.text;
    }

    for (const field of nameFields) {
      const nameNode = node.childForFieldName(field);
      if (nameNode) {
        return nameNode.text;
      }

      const descendantNodes = node.descendantsOfType(field);
      if (descendantNodes.length > 0) {
        return descendantNodes[0].text;
      }
    }

    return null;
  }

  /**
   * Parse generic code into fixed-size chunks
   */
  private parseGenericCode(code: string, language: string): EmbeddingChunk[] {
    this.logger.debug(`Using generic line-based chunking for language: ${language}`);
    const lines = code.split('\n');
    const MAX_CHUNK_SIZE = 100;
    const chunks: EmbeddingChunk[] = [];

    for (let i = 0; i < lines.length; i += MAX_CHUNK_SIZE) {
      const chunkLines = lines.slice(i, i + MAX_CHUNK_SIZE);
      if (chunkLines.every(line => line.trim() === '')) continue;

      const chunk: EmbeddingChunk = {
        codeChunkText: chunkLines.join('\n'),
        startLine: i + 1,
        endLine: Math.min(i + MAX_CHUNK_SIZE, lines.length),
        language,
        chunkType: 'code',
        symbolName: null,
      };
      chunks.push(chunk);
    }
    return chunks;
  }
}
