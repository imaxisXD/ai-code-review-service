/**
 * API utility to access Convex functions
 */
export const api = {
  embeddings: {
    storeEmbedding: 'embeddings:storeEmbedding',
    searchEmbeddings: 'embeddings:searchEmbeddings',
    getEmbeddingsForFile: 'embeddings:getEmbeddingsForFile',
  },
  relationships: {
    storeRelationship: 'relationships:storeRelationship',
    getRelationships: 'relationships:getRelationships',
    getOutgoingDependencies: 'relationships:getOutgoingDependencies',
    getIncomingDependencies: 'relationships:getIncomingDependencies',
  },
  repositories: {
    createRepository: 'repositories:createRepository',
    getRepository: 'repositories:getRepository',
    listRepositories: 'repositories:listRepositories',
    updateRepositoryStatus: 'repositories:updateRepositoryStatus',
  },
};
