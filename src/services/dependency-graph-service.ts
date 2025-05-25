import { CodeRelationship } from '../types.js';
import { logger } from '../utils/logger.js';

// Node in the dependency graph
export type DependencyNode = {
  id: string; // Unique identifier (usually filePath:symbolName)
  filePath: string;
  symbolName: string | null;
  type: string; // Symbol type (class, function, method, etc.)
};

// Edge in the dependency graph
export type DependencyEdge = {
  source: string; // Source node ID
  target: string; // Target node ID
  type: string; // Relationship type (function_call, import, inheritance, etc.)
  weight: number; // Edge weight (e.g., number of calls)
};

// Graph data structure
export class DependencyGraph {
  private nodes: Map<string, DependencyNode>;
  private outgoingEdges: Map<string, Set<DependencyEdge>>;
  private incomingEdges: Map<string, Set<DependencyEdge>>;

  constructor() {
    this.nodes = new Map();
    this.outgoingEdges = new Map();
    this.incomingEdges = new Map();
  }

  /**
   * Add a node to the graph
   */
  addNode(node: DependencyNode): void {
    const nodeId = this.getNodeId(node.filePath, node.symbolName);

    if (!this.nodes.has(nodeId)) {
      this.nodes.set(nodeId, node);
      this.outgoingEdges.set(nodeId, new Set());
      this.incomingEdges.set(nodeId, new Set());
    }
  }

  /**
   * Add an edge between two nodes
   */
  addEdge(edge: DependencyEdge): void {
    if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) {
      logger.warn('Attempted to add edge between nonexistent nodes', { edge });
      return;
    }

    // Add to outgoing edges
    const outgoing = this.outgoingEdges.get(edge.source);
    if (outgoing) {
      // Check if an edge with the same source and target already exists
      let existingEdge: DependencyEdge | undefined;
      for (const e of outgoing) {
        if (e.source === edge.source && e.target === edge.target && e.type === edge.type) {
          existingEdge = e;
          break;
        }
      }

      if (existingEdge) {
        // Update weight of existing edge
        existingEdge.weight += edge.weight;
        // Remove and re-add to ensure the set is updated
        outgoing.delete(existingEdge);
        outgoing.add(existingEdge);
      } else {
        outgoing.add(edge);
      }
    }

    // Add to incoming edges
    const incoming = this.incomingEdges.get(edge.target);
    if (incoming) {
      // Check if an edge with the same source and target already exists
      let existingEdge: DependencyEdge | undefined;
      for (const e of incoming) {
        if (e.source === edge.source && e.target === edge.target && e.type === edge.type) {
          existingEdge = e;
          break;
        }
      }

      if (existingEdge) {
        // Update weight of existing edge
        existingEdge.weight += edge.weight;
        // Remove and re-add to ensure the set is updated
        incoming.delete(existingEdge);
        incoming.add(existingEdge);
      } else {
        incoming.add(edge);
      }
    }
  }

  /**
   * Get all nodes in the graph
   */
  getNodes(): DependencyNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get a specific node by ID
   */
  getNode(nodeId: string): DependencyNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Get all outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string): DependencyEdge[] {
    return Array.from(this.outgoingEdges.get(nodeId) || []);
  }

  /**
   * Get all incoming edges to a node
   */
  getIncomingEdges(nodeId: string): DependencyEdge[] {
    return Array.from(this.incomingEdges.get(nodeId) || []);
  }

  /**
   * Find all direct dependents of a node
   */
  findDependents(filePath: string, symbolName: string | null): DependencyNode[] {
    const nodeId = this.getNodeId(filePath, symbolName);
    if (!this.nodes.has(nodeId)) {
      return [];
    }

    const outEdges = this.getOutgoingEdges(nodeId);
    return outEdges.map((edge) => this.nodes.get(edge.target)!).filter(Boolean);
  }

  /**
   * Find all nodes that depend on the given node (transitive closure)
   */
  transitiveClosureDependents(
    filePath: string,
    symbolName: string | null,
    maxDepth: number = Infinity
  ): DependencyNode[] {
    const nodeId = this.getNodeId(filePath, symbolName);
    const visited = new Set<string>();
    const result: DependencyNode[] = [];

    // Helper function for depth-first search
    const dfs = (currentId: string, depth: number = 0) => {
      if (visited.has(currentId) || depth > maxDepth) {
        return;
      }
      visited.add(currentId);

      const currentNode = this.nodes.get(currentId);
      if (currentNode && currentId !== nodeId) {
        result.push(currentNode);
      }

      if (depth < maxDepth) {
        const edges = this.getIncomingEdges(currentId);
        for (const edge of edges) {
          dfs(edge.source, depth + 1);
        }
      }
    };

    dfs(nodeId);
    return result;
  }

  /**
   * Find all direct dependencies of a node
   */
  findDependencies(filePath: string, symbolName: string | null): DependencyNode[] {
    const nodeId = this.getNodeId(filePath, symbolName);
    if (!this.nodes.has(nodeId)) {
      return [];
    }

    const inEdges = this.getIncomingEdges(nodeId);
    return inEdges.map((edge) => this.nodes.get(edge.source)!).filter(Boolean);
  }

  /**
   * Find all dependencies of a node up to a certain depth
   */
  findDependenciesRecursive(
    filePath: string,
    symbolName: string | null,
    maxDepth: number = 2
  ): DependencyNode[] {
    const nodeId = this.getNodeId(filePath, symbolName);
    const visited = new Set<string>();
    const result: DependencyNode[] = [];

    // Helper function for depth-first search
    const dfs = (currentId: string, depth: number = 0) => {
      if (visited.has(currentId) || depth > maxDepth) {
        return;
      }
      visited.add(currentId);

      // Don't add the starting node to results
      if (depth > 0) {
        const currentNode = this.nodes.get(currentId);
        if (currentNode) {
          result.push(currentNode);
        }
      }

      if (depth < maxDepth) {
        const edges = this.getOutgoingEdges(currentId);
        for (const edge of edges) {
          dfs(edge.target, depth + 1);
        }
      }
    };

    dfs(nodeId);
    return result;
  }

  /**
   * Find all dependents of a node up to a certain depth
   */
  findDependentsRecursive(
    filePath: string,
    symbolName: string | null,
    maxDepth: number = 2
  ): DependencyNode[] {
    const nodeId = this.getNodeId(filePath, symbolName);
    const visited = new Set<string>();
    const result: DependencyNode[] = [];

    // Helper function for depth-first search
    const dfs = (currentId: string, depth: number = 0) => {
      if (visited.has(currentId) || depth > maxDepth) {
        return;
      }
      visited.add(currentId);

      // Don't add the starting node to results
      if (depth > 0) {
        const currentNode = this.nodes.get(currentId);
        if (currentNode) {
          result.push(currentNode);
        }
      }

      if (depth < maxDepth) {
        const edges = this.getIncomingEdges(currentId);
        for (const edge of edges) {
          dfs(edge.source, depth + 1);
        }
      }
    };

    dfs(nodeId);
    return result;
  }

  /**
   * Generate a unique ID for a node
   */
  private getNodeId(filePath: string, symbolName: string | null): string {
    return `${filePath}:${symbolName || 'file'}`;
  }
}

/**
 * Create a dependency graph service
 */
export function createDependencyGraphService() {
  // Cache of dependency graphs by repository ID
  const graphCache = new Map<string, DependencyGraph>();

  /**
   * Build a dependency graph from code relationships
   */
  function buildDependencyGraph(relationships: CodeRelationship[]): DependencyGraph {
    const graph = new DependencyGraph();

    // First, create nodes for all sources and targets
    for (const relationship of relationships) {
      // Add source node
      graph.addNode({
        id: `${relationship.location.filePath}:${relationship.source}`,
        filePath: relationship.location.filePath,
        symbolName: relationship.source,
        type: relationship.type,
      });

      // Add target node
      graph.addNode({
        id: `${relationship.location.filePath}:${relationship.target}`,
        filePath: relationship.location.filePath,
        symbolName: relationship.target,
        type: relationship.type,
      });
    }

    // Then, add edges between nodes
    for (const relationship of relationships) {
      const sourceId = `${relationship.location.filePath}:${relationship.source}`;
      const targetId = `${relationship.location.filePath}:${relationship.target}`;

      graph.addEdge({
        source: sourceId,
        target: targetId,
        type: relationship.type,
        weight: 1,
      });
    }

    return graph;
  }

  /**
   * Get or create a dependency graph for a repository
   */
  async function getDependencyGraph(
    repositoryId: string,
    fetchRelationships: () => Promise<CodeRelationship[]>
  ): Promise<DependencyGraph> {
    // Check if we have a cached graph for this repository
    if (graphCache.has(repositoryId)) {
      return graphCache.get(repositoryId)!;
    }

    // Fetch relationships from the database
    const relationships = await fetchRelationships();

    // Build the dependency graph
    const graph = buildDependencyGraph(relationships);

    // Cache the graph for future use
    graphCache.set(repositoryId, graph);

    return graph;
  }

  /**
   * Clear the cache for a repository
   */
  function clearCache(repositoryId: string): void {
    graphCache.delete(repositoryId);
  }

  /**
   * Clear all caches
   */
  function clearAllCaches(): void {
    graphCache.clear();
  }

  /**
   * Get critical paths for a node
   * A critical path is a path from the node to a high-importance node
   */
  function identifyCriticalPaths(
    graph: DependencyGraph,
    filePath: string,
    symbolName: string | null,
    criticalityScores: Map<string, number>
  ): { path: DependencyNode[]; score: number }[] {
    const nodeId = graph['getNodeId'](filePath, symbolName);
    const node = graph.getNode(nodeId);

    if (!node) {
      return [];
    }

    const criticalPaths: { path: DependencyNode[]; score: number }[] = [];
    const visited = new Set<string>();

    // DFS to find paths to critical nodes
    function dfs(
      currentId: string,
      currentPath: DependencyNode[],
      currentNode: DependencyNode
    ): void {
      if (visited.has(currentId)) {
        return;
      }

      visited.add(currentId);
      currentPath.push(currentNode);

      // Check if this is a critical node
      const score = criticalityScores.get(currentId) || 0;
      if (score > 0.7) {
        // Threshold for critical nodes
        criticalPaths.push({
          path: [...currentPath],
          score,
        });
      }

      // Continue DFS
      const outgoingEdges = graph.getOutgoingEdges(currentId);
      for (const edge of outgoingEdges) {
        const targetNode = graph.getNode(edge.target);
        if (targetNode) {
          dfs(edge.target, [...currentPath], targetNode);
        }
      }
    }

    dfs(nodeId, [], node);

    // Sort paths by criticality score
    return criticalPaths.sort((a, b) => b.score - a.score);
  }

  /**
   * Calculate impact score for a change based on dependent components
   */
  function calculateImpactScore(
    dependents: DependencyNode[],
    criticalityScores: Map<string, number>
  ): number {
    if (dependents.length === 0) {
      return 0;
    }

    let totalScore = 0;

    for (const dependent of dependents) {
      const nodeId = `${dependent.filePath}:${dependent.symbolName || 'file'}`;
      const score = criticalityScores.get(nodeId) || 0;
      totalScore += score;
    }

    // Normalize score by number of dependents
    return totalScore / dependents.length;
  }

  /**
   * Determine severity level based on impact score
   */
  function determineSeverityLevel(impactScore: number): 'low' | 'medium' | 'high' | 'critical' {
    if (impactScore >= 0.8) {
      return 'critical';
    } else if (impactScore >= 0.6) {
      return 'high';
    } else if (impactScore >= 0.3) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  return {
    getDependencyGraph,
    clearCache,
    clearAllCaches,
    identifyCriticalPaths,
    calculateImpactScore,
    determineSeverityLevel,
    // Expose the new methods
    findDependenciesWithDepth: (
      graph: DependencyGraph,
      filePath: string,
      symbolName: string | null,
      maxDepth: number = 2
    ) => graph.findDependenciesRecursive(filePath, symbolName, maxDepth),

    findDependentsWithDepth: (
      graph: DependencyGraph,
      filePath: string,
      symbolName: string | null,
      maxDepth: number = 2
    ) => graph.findDependentsRecursive(filePath, symbolName, maxDepth),

    transitiveClosureWithDepth: (
      graph: DependencyGraph,
      filePath: string,
      symbolName: string | null,
      maxDepth: number = Infinity
    ) => graph.transitiveClosureDependents(filePath, symbolName, maxDepth),
  };
}
