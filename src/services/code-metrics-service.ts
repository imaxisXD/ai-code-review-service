import { EmbeddingChunk, ComplexityMetrics, SemanticType, EnhancedCodeChunk } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Calculate the cyclomatic complexity of a code chunk
 * Basic implementation - counts decision points
 */
function calculateCyclomaticComplexity(codeText: string): number {
  // Count common control structures and logical operators
  const controlStructures = [
    /\bif\s*\(/g, // if statements
    /\belse\s+if\s*\(/g, // else if
    /\bfor\s*\(/g, // for loops
    /\bwhile\s*\(/g, // while loops
    /\bdo\s*\{/g, // do-while loops
    /\bswitch\s*\(/g, // switch statements
    /\bcase\s+/g, // case statements
    /\bcatch\s*\(/g, // catch statements
    /\b\|\|/g, // logical OR
    /\b&&/g, // logical AND
    /\?/g, // ternary operators
  ];

  let complexity = 1; // Base complexity is 1

  for (const pattern of controlStructures) {
    const matches = codeText.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}

/**
 * Estimate cognitive complexity of a code chunk
 * This is a simplified version
 */
function estimateCognitiveComplexity(codeText: string): number {
  let complexity = 0;

  // Simple heuristics for cognitive complexity
  // 1. Control flow nesting increases complexity
  const nestingDepth = calculateNestingDepth(codeText);
  complexity += nestingDepth * 2;

  // 2. Multiple return statements increase complexity
  const returnStatements = (codeText.match(/\breturn\s+/g) || []).length;
  complexity += returnStatements > 1 ? returnStatements - 1 : 0;

  // 3. Long identifiers add to cognitive load
  const longIdentifiers = (codeText.match(/\b[a-zA-Z][a-zA-Z0-9]{20,}\b/g) || []).length;
  complexity += longIdentifiers;

  // 4. Count complex logical expressions (those with mixed operators)
  const complexExpressions =
    (codeText.match(/\(.+&&.+\|\|.+\)/g) || []).length +
    (codeText.match(/\(.+\|\|.+&&.+\)/g) || []).length;
  complexity += complexExpressions * 2;

  return complexity + Math.floor(calculateCyclomaticComplexity(codeText) / 2);
}

/**
 * Calculate the nesting depth of code
 */
function calculateNestingDepth(codeText: string): number {
  const lines = codeText.split('\n');
  let maxDepth = 0;
  let currentDepth = 0;

  for (const line of lines) {
    // Count opening braces on the line
    const openingBraces = (line.match(/\{/g) || []).length;
    currentDepth += openingBraces;

    // Update max depth if current is higher
    maxDepth = Math.max(maxDepth, currentDepth);

    // Count closing braces on the line
    const closingBraces = (line.match(/\}/g) || []).length;
    currentDepth -= closingBraces;
  }

  return maxDepth;
}

/**
 * Count parameters in a function
 */
function countParameters(codeText: string): number {
  // Look for function/method declarations
  const funcMatch = codeText.match(/function\s+[\w$]+\s*\((.*?)\)/);
  if (funcMatch && funcMatch[1]) {
    const params = funcMatch[1].trim();
    return params ? params.split(',').length : 0;
  }

  // Look for arrow functions
  const arrowMatch = codeText.match(/\((.*?)\)\s*=>/);
  if (arrowMatch && arrowMatch[1]) {
    const params = arrowMatch[1].trim();
    return params ? params.split(',').length : 0;
  }

  // Look for method definitions
  const methodMatch = codeText.match(/[\w$]+\s*\((.*?)\)\s*\{/);
  if (methodMatch && methodMatch[1]) {
    const params = methodMatch[1].trim();
    return params ? params.split(',').length : 0;
  }

  return 0;
}

/**
 * Detect the semantic type of code
 */
function detectSemanticType(chunk: EmbeddingChunk): SemanticType {
  const text = chunk.codeChunkText.toLowerCase();

  // Check for authentication/authorization patterns
  if (
    text.includes('auth') ||
    text.includes('login') ||
    text.includes('password') ||
    text.includes('credential')
  ) {
    if (text.includes('role') || text.includes('permission') || text.includes('access control')) {
      return 'authorization';
    }
    return 'authentication';
  }

  // Check for data access patterns
  if (
    text.includes('db') ||
    text.includes('database') ||
    text.includes('query') ||
    (text.includes('select') && text.includes('from')) ||
    text.includes('insert') ||
    text.includes('update') ||
    text.includes('repository') ||
    text.includes('dao')
  ) {
    return 'data-access';
  }

  // Check for UI component patterns
  if (
    text.includes('ui') ||
    text.includes('component') ||
    text.includes('render') ||
    text.includes('view') ||
    text.includes('<div') ||
    text.includes('useeffect') ||
    text.includes('usestate')
  ) {
    return 'ui-component';
  }

  // Check for API endpoints
  if (
    text.includes('api') ||
    text.includes('endpoint') ||
    text.includes('route') ||
    text.includes('controller') ||
    (text.includes('get') && text.includes('post') && text.includes('request'))
  ) {
    return 'api-endpoint';
  }

  // Check for test code
  if (
    text.includes('test') ||
    text.includes('assert') ||
    text.includes('expect') ||
    text.includes('mock') ||
    text.includes('spec') ||
    (text.includes('describe') && text.includes('it('))
  ) {
    return 'test';
  }

  // Check for validation logic
  if (
    text.includes('valid') ||
    text.includes('check') ||
    text.includes('sanitize') ||
    text.includes('verify')
  ) {
    return 'validation';
  }

  // Check for error handling
  if (
    text.includes('exception') ||
    text.includes('error') ||
    (text.includes('try') && text.includes('catch')) ||
    text.includes('throw')
  ) {
    return 'error-handling';
  }

  // Check for configuration
  if (
    text.includes('config') ||
    text.includes('setting') ||
    text.includes('setup') ||
    text.includes('options') ||
    text.includes('env')
  ) {
    return 'config';
  }

  // Utility functions
  if (text.includes('util') || text.includes('helper') || text.includes('common')) {
    return 'utility';
  }

  // Default to business logic
  if (chunk.chunkType === 'function' || chunk.chunkType === 'method') {
    return 'business-logic';
  }

  return 'unclassified';
}

/**
 * Calculate code complexity metrics
 */
function calculateComplexity(
  chunk: EmbeddingChunk,
  dependencyCount: number,
  dependentCount: number
): ComplexityMetrics {
  const code = chunk.codeChunkText;
  const cyclomatic = calculateCyclomaticComplexity(code);
  const cognitive = estimateCognitiveComplexity(code);
  const nesting = calculateNestingDepth(code);
  const paramCount =
    chunk.chunkType === 'function' || chunk.chunkType === 'method'
      ? countParameters(code)
      : undefined;

  return {
    cyclomaticComplexity: cyclomatic,
    cognitiveComplexity: cognitive,
    linesOfCode: code.split('\n').length,
    parameterCount: paramCount,
    nestingDepth: nesting,
    dependencyCount,
    dependentCount,
  };
}

/**
 * Code metrics service
 */
export function createCodeMetricsService() {
  /**
   * Generate tags for a code chunk
   */
  function generateTags(
    chunk: EmbeddingChunk,
    semanticType: SemanticType,
    complexity: ComplexityMetrics
  ): string[] {
    const tags: string[] = [semanticType];

    // Add complexity-based tags
    if (complexity.cyclomaticComplexity > 10) {
      tags.push('high-cyclomatic-complexity');
    }

    if (complexity.cognitiveComplexity > 15) {
      tags.push('high-cognitive-complexity');
    }

    if (complexity.nestingDepth && complexity.nestingDepth > 3) {
      tags.push('deeply-nested');
    }

    if (complexity.dependencyCount > 5) {
      tags.push('many-dependencies');
    }

    if (complexity.dependentCount > 5) {
      tags.push('highly-depended-on');
    }

    if (complexity.linesOfCode > 100) {
      tags.push('long-code-block');
    }

    // Add language-specific tags
    if (chunk.language) {
      tags.push(`lang:${chunk.language}`);
    }

    // Add type-specific tags
    if (chunk.chunkType) {
      tags.push(`type:${chunk.chunkType}`);
    }

    // Add symbol name tag if available
    if (chunk.symbolName) {
      tags.push(`symbol:${chunk.symbolName}`);
    }

    return tags;
  }

  /**
   * Calculate change frequency (0-1) for a file path and line range
   * This is a stub - actual implementation would query git history
   */
  async function getChangeFrequency(
    filePath: string,
    startLine: number,
    endLine: number,
    repositoryPath: string
  ): Promise<number> {
    // TODO: Implement actual git history analysis
    // This would run commands like:
    // git log -L <startLine>,<endLine>:<filePath> --since=6.months

    logger.debug('Calculating change frequency', { filePath, startLine, endLine, repositoryPath });

    // For now, return a random value between 0.1 and 0.9
    return 0.1 + Math.random() * 0.8;
  }

  /**
   * Enhance a code chunk with semantic metadata
   */
  async function enhanceChunk(
    chunk: EmbeddingChunk,
    dependencies: string[],
    dependents: string[],
    repositoryPath: string
  ): Promise<EnhancedCodeChunk> {
    const semanticType = detectSemanticType(chunk);

    const complexity = calculateComplexity(chunk, dependencies.length, dependents.length);

    const changeFrequency = await getChangeFrequency(
      chunk.symbolName ?? `${chunk.startLine}-${chunk.endLine}`,
      chunk.startLine,
      chunk.endLine,
      repositoryPath
    );

    const tags = generateTags(chunk, semanticType, complexity);

    return {
      ...chunk,
      metadata: {
        dependencies,
        dependents,
        semanticType,
        complexity,
        changeFrequency,
        tags,
      },
    };
  }

  return {
    calculateComplexity,
    detectSemanticType,
    getChangeFrequency,
    enhanceChunk,
  };
}
