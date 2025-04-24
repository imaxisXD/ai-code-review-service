// src/services/file-processor-service.ts
import fs from 'fs/promises';
import path from 'path';
import { Logger } from '../utils/logger';
import { EmbeddingChunk } from '../types';

// This is a simplified implementation. For production, you might want to:
// 1. Add tree-sitter for proper parsing
// 2. Add language-specific chunking logic
// 3. Add support for more file types

interface FileProcessorServiceOptions {
  logger: Logger;
}

export class FileProcessorService {
  private logger: Logger;
  private IGNORE_DIRS = [
    'node_modules', '.git', 'dist', 'build', 'coverage',
    '.cache', '.github', '.idea', '.vscode'
  ];
  private IGNORE_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico', '.webp',
    '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z',
    '.exe', '.dll', '.so', '.o', '.obj', '.class',
    '.min.js', '.min.css',
    '.lock', '.log'
  ];
  private MAX_FILE_SIZE = 1024 * 1024; // 1MB
  
  constructor(options: FileProcessorServiceOptions) {
    this.logger = options.logger;
  }

  /**
   * Get all files in a directory recursively
   */
  public async getAllFilesRecursive(dirPath: string): Promise<string[]> {
    let results: string[] = [];
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          if (this.shouldIgnoreDirectory(entry.name)) {
            this.logger.debug(`Skipping ignored directory`, { directory: entry.name });
            continue;
          }
          
          const subResults = await this.getAllFilesRecursive(fullPath);
          results = results.concat(subResults);
        } else {
          results.push(fullPath);
        }
      }
    } catch (error) {
      this.logger.error(`Error reading directory`, { 
        dirPath, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
    
    return results;
  }

  /**
   * Determine if a file should be processed
   */
  public shouldProcessFile(filePath: string): boolean {
    // Skip files with ignored extensions
    const extension = path.extname(filePath).toLowerCase();
    if (this.IGNORE_EXTENSIONS.includes(extension)) {
      return false;
    }
    
    // Skip files in ignored directories
    const pathParts = filePath.split(path.sep);
    for (const dir of this.IGNORE_DIRS) {
      if (pathParts.includes(dir)) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Check if directory should be ignored
   */
  private shouldIgnoreDirectory(dirName: string): boolean {
    return this.IGNORE_DIRS.includes(dirName);
  }

  /**
   * Parse file and create chunks for embedding
   */
  public async parseAndChunkFile(filePath: string): Promise<EmbeddingChunk[]> {
    try {
      // Check file size
      const stats = await fs.stat(filePath);
      if (stats.size > this.MAX_FILE_SIZE) {
        this.logger.debug(`Skipping large file`, { filePath, size: stats.size });
        return [];
      }
      
      // Read file content
      const content = await fs.readFile(filePath, 'utf8');
      
      // Skip binary files
      if (this.isProbablyBinary(content)) {
        this.logger.debug(`Skipping binary file`, { filePath });
        return [];
      }
      
      // Get file extension
      const extension = path.extname(filePath).toLowerCase().slice(1);
      const language = this.getLanguageFromExtension(extension);
      
      // Simple line-based chunking for this example
      // In a real implementation, you'd use a proper parser like tree-sitter
      return this.createSimpleChunks(content, language);
    } catch (error) {
      this.logger.error(`Error processing file`, { 
        filePath, 
        error: error instanceof Error ? error.message : String(error) 
      });
      return [];
    }
  }

  /**
   * Simple check if content is binary
   */
  private isProbablyBinary(content: string): boolean {
    // This is a simple heuristic - in production you might want a more sophisticated check
    // Check for null bytes or high concentration of non-UTF8 characters
    return /[\x00-\x08\x0E-\x1F]/.test(content.slice(0, 1000));
  }

  /**
   * Map file extension to language
   */
  private getLanguageFromExtension(extension: string): string {
    const languageMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'jsx': 'javascript',
      'tsx': 'typescript',
      'py': 'python',
      'rb': 'ruby',
      'java': 'java',
      'go': 'go',
      'c': 'c',
      'cpp': 'cpp',
      'cs': 'csharp',
      'php': 'php',
      'html': 'html',
      'css': 'css',
      'md': 'markdown',
      'json': 'json',
      'yml': 'yaml',
      'yaml': 'yaml',
      'sh': 'shell',
      'bash': 'shell',
      'sql': 'sql',
      // Add more as needed
    };
    
    return languageMap[extension] || 'text';
  }

  /**
   * Create simple chunks from file content
   * In production, use a proper parser for better chunking
   */
  private createSimpleChunks(content: string, language: string): EmbeddingChunk[] {
    const lines = content.split('\n');
    const MAX_CHUNK_SIZE = 100; // lines
    const chunks: EmbeddingChunk[] = [];
    
    // Simple chunking by fixed number of lines
    for (let i = 0; i < lines.length; i += MAX_CHUNK_SIZE) {
      const chunkLines = lines.slice(i, i + MAX_CHUNK_SIZE);
      const chunk: EmbeddingChunk = {
        codeChunkText: chunkLines.join('\n'),
        startLine: i + 1,
        endLine: Math.min(i + MAX_CHUNK_SIZE, lines.length),
        language,
        chunkType: 'code',
        symbolName: null
      };
      
      chunks.push(chunk);
    }
    
    return chunks;
  }
}