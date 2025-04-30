# Advanced Code Review System: Semantic-First Architecture

## System Overview

This document outlines the architecture and implementation details for our advanced semantic-first code review system that combines AST parsing, multi-level vector search, and specialized LLM analysis to provide high-quality automated code reviews.

## Architecture Diagram

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    PR Event     │────▶│ Semantic Parser │────▶│ Pre-Prioritizer │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
┌─────────────────┐     ┌─────────────────┐              ▼
│  Context Builder│◀────│ Impact Analysis │◀────┌─────────────────┐
└─────────────────┘     └─────────────────┘     │ Vector Retrieval│
        │                                       └─────────────────┘
        ▼                                               │
┌─────────────────┐     ┌─────────────────┐             │
│Multi-Stage LLM  │────▶│ Review Merger   │◀────────────┘
└─────────────────┘     └─────────────────┘
        │                        │
        │                        ▼
        │              ┌─────────────────┐
        └─────────────▶│  PR Integration │
                       └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │ Feedback System │
                       └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │Learning Pipeline│
                       └─────────────────┘
```

## Core Components

### 1. Semantic Parser

Uses AST (Abstract Syntax Tree) parsing to extract meaningful code structures rather than just line-by-line analysis:

```javascript
async function semanticParser(prDiff) {
  // Get files affected by PR
  const files = await gitService.getFilesFromPR(prDiff);

  // Parse files into ASTs using TreeSitter
  const parsedFiles = await Promise.all(
    files.map(async file => {
      // Generate AST for the file
      const ast = await treeSitterService.parseFile(file.content, file.language);

      // Extract semantic units (functions, classes, methods)
      const units = treeSitterService.extractSemanticUnits(ast);

      return {
        path: file.path,
        language: file.language,
        ast,
        semanticUnits: units,
      };
    })
  );

  // Match diff hunks to semantic units
  const modifiedUnits = diffService.matchDiffToSemanticUnits(prDiff, parsedFiles);

  return {
    parsedFiles,
    modifiedUnits,
  };
}
```

#### Key Features:

- Identifies functions, classes, and methods as meaningful units
- Preserves scope and context information
- Maps PR diff changes to semantic units rather than just lines
- Supports multiple languages through TreeSitter

### 2. Pre-Prioritizer

Performs quick analysis to prioritize code units for deeper review:

```javascript
async function prePrioritize(modifiedUnits) {
  // Run static analysis for quick potential issue detection
  const staticAnalysisResults = await Promise.all(
    modifiedUnits.map(unit => staticAnalyzer.quickScan(unit.code, unit.language))
  );

  // Calculate complexity metrics
  const complexityScores = modifiedUnits.map(unit => ({
    unitId: unit.id,
    cyclomatic: calculateCyclomaticComplexity(unit.ast),
    cognitive: calculateCognitiveComplexity(unit.ast),
    linesChanged: unit.linesChanged,
    nestingDepth: calculateNestingDepth(unit.ast),
  }));

  // Calculate overall priority scores
  const priorityScores = modifiedUnits.map((unit, index) => ({
    unit,
    score: calculatePriorityScore(staticAnalysisResults[index], complexityScores[index]),
  }));

  // Sort by priority
  return priorityScores.sort((a, b) => b.score - a.score);
}
```

#### Key Features:

- Fast initial assessment to focus review efforts
- Multiple complexity metrics for accurate prioritization
- Integration with static analysis tools
- Performance-optimized to avoid review bottlenecks

### 3. Multi-Level Vector Retrieval

Performs tiered similarity searches to find relevant code contexts:

```javascript
async function multiLevelVectorRetrieval(semanticUnit, repository) {
  // Level 1: Find similar specific structures (functions with similar purpose)
  const structureSimilarity = await vectorDb.query.codeEmbeddings.withIndex(
    'by_structure_embedding',
    q =>
      q
        .filter({
          repositoryId: repository._id,
          language: semanticUnit.language,
          type: semanticUnit.type,
        })
        .vectorSearch('embedding', semanticUnit.embedding, { numResults: 5 })
  );

  // Level 2: Find similar patterns in the same file/module
  const moduleSimilarity = await vectorDb.query.codeEmbeddings.withIndex('by_module_embedding', q =>
    q
      .filter({
        repositoryId: repository._id,
        modulePath: getModulePath(semanticUnit.filePath),
      })
      .vectorSearch('embedding', semanticUnit.embedding, { numResults: 5 })
  );

  // Level 3: Find project-wide conventions and patterns
  const conventionSimilarity = await vectorDb.query.projectPatterns.withIndex(
    'by_pattern_embedding',
    q =>
      q
        .filter({
          repositoryId: repository._id,
          language: semanticUnit.language,
        })
        .vectorSearch('embedding', semanticUnit.embedding, { numResults: 5 })
  );

  return {
    similar: {
      structures: await fetchContextForEmbeddings(structureSimilarity),
      modulePatterns: await fetchContextForEmbeddings(moduleSimilarity),
      projectConventions: await fetchContextForEmbeddings(conventionSimilarity),
    },
  };
}
```

#### Key Features:

- Three-tiered approach for comprehensive context
- Structure-aware embeddings for more accurate similarity
- Module-level context for local patterns
- Project-wide conventions for consistency checking

### 4. Impact Analysis

Evaluates how the changed code affects the rest of the codebase:

```javascript
async function analyzeImpact(semanticUnit, repository) {
  // Build dependency graph if not cached
  const dependencyGraph = await getDependencyGraph(repository._id);

  // Find components directly dependent on this unit
  const directDependents = dependencyGraph.findDependents(semanticUnit.filePath, semanticUnit.name);

  // Calculate transitive closure to find all affected components
  const allAffected = dependencyGraph.transitiveClosureDependents(
    semanticUnit.filePath,
    semanticUnit.name
  );

  // Get criticality metrics for affected components
  const criticalityData = await Promise.all(
    allAffected.map(component => metricsService.getComponentCriticality(repository._id, component))
  );

  // Calculate impact score based on affected components
  const impactScore = calculateImpactScore(criticalityData);

  return {
    directDependents,
    allAffected,
    criticalPaths: identifyCriticalPaths(allAffected, criticalityData),
    impactScore,
    severityLevel: determineSeverityLevel(impactScore),
  };
}
```

#### Key Features:

- Dependency graph analysis for impact assessment
- Identification of critical code paths affected
- Severity rating for changes based on impact
- Integration with code complexity metrics

### 5. Context Builder

Combines data from multiple sources to build rich context for review:

```javascript
async function buildContext(semanticUnit, vectorResults, impactAnalysis, repository) {
  // Get historical data for similar units
  const historicalData = await historyService.getRelevantHistory(
    repository._id,
    semanticUnit,
    vectorResults.similar.structures
  );

  // Get organizational best practices and rules
  const orgRules = await rulesService.getOrganizationRules(
    repository.organizationId,
    semanticUnit.language,
    semanticUnit.type
  );

  // Combine all context sources
  return {
    semanticUnit,
    similarCode: vectorResults.similar,
    impact: impactAnalysis,
    history: {
      previousReviews: historicalData.previousReviews,
      bugHistory: historicalData.relatedBugs,
      acceptedPatterns: historicalData.acceptedPatterns,
    },
    organizationRules: orgRules,
    repository: {
      name: repository.name,
      language: repository.primaryLanguage,
      codeStyleGuide: repository.styleGuide,
    },
  };
}
```

#### Key Features:

- Integration of similarity, impact, and historical data
- Organization-specific rules and best practices
- Bug history for detecting potential regressions
- Style guides for consistency checking

### 6. Multi-Stage LLM Review

Uses specialized LLMs for different aspects of code review:

```javascript
async function multiStageLLMReview(context) {
  // Stage 1: Structural Review (architecture, design patterns)
  const structuralReview = await llmService.analyze({
    model: 'gpt-4-turbo',
    task: 'structural_code_review',
    context: {
      code: context.semanticUnit.code,
      type: context.semanticUnit.type,
      similar: context.similarCode.structures,
      conventions: context.similarCode.projectConventions,
      organizationRules: context.organizationRules,
    },
    temperature: 0.2,
  });

  // Stage 2: Specialized Reviews based on unit type and impact
  const specializedReviews = await Promise.all(
    [
      // Security review (if applicable)
      context.semanticUnit.securitySensitive || context.impact.severityLevel >= 3
        ? llmService.analyze({
            model: 'security-specialized-model',
            task: 'security_review',
            context: {
              code: context.semanticUnit.code,
              type: context.semanticUnit.type,
              history: context.history.bugHistory.securityBugs,
              impact: context.impact,
            },
          })
        : null,

      // Performance review (if applicable)
      context.semanticUnit.performanceSensitive || context.impact.impactScore >= 7
        ? llmService.analyze({
            model: 'performance-specialized-model',
            task: 'performance_review',
            context: {
              code: context.semanticUnit.code,
              similar: context.similarCode.structures,
              impact: context.impact,
            },
          })
        : null,

      // Code quality & maintainability review (always applicable)
      llmService.analyze({
        model: 'quality-specialized-model',
        task: 'quality_review',
        context: {
          code: context.semanticUnit.code,
          type: context.semanticUnit.type,
          similar: context.similarCode.modulePatterns,
          history: context.history,
        },
      }),
    ].filter(Boolean)
  );

  return {
    structuralReview,
    specializedReviews: specializedReviews.filter(r => r !== null),
  };
}
```

#### Key Features:

- Two-stage review process (structural then specialized)
- Targeted specialized reviews based on code characteristics
- Model selection based on review type
- Optimized prompting for each review category

### 7. Review Merger

Intelligently combines reviews from different stages and models:

```javascript
function mergeReviews(structuralReview, specializedReviews, context) {
  // Extract all comments from different review stages
  const allComments = [
    ...extractComments(structuralReview),
    ...specializedReviews.flatMap(review => extractComments(review)),
  ];

  // De-duplicate similar comments
  const uniqueComments = deduplicateComments(allComments);

  // Group related comments
  const groupedComments = groupRelatedComments(uniqueComments, context.semanticUnit.ast);

  // Sort by priority
  const sortedGroups = sortCommentsByPriority(groupedComments, context.impact);

  // Generate summaries for each comment group
  const commentGroups = sortedGroups.map(group => ({
    comments: group,
    summary: generateGroupSummary(group),
    priority: calculateGroupPriority(group, context.impact),
    suggestion: canGenerateSuggestion(group) ? generateCodeSuggestion(group, context) : null,
  }));

  // Generate overall summary
  const overallSummary = generateOverallSummary(commentGroups, structuralReview, context);

  return {
    commentGroups,
    overallSummary,
    metadata: {
      unitReviewed: context.semanticUnit.name,
      impactScore: context.impact.impactScore,
      modelsUsed: ['structural', ...specializedReviews.map(r => r.modelType)],
    },
  };
}
```

#### Key Features:

- Intelligent comment de-duplication and grouping
- Prioritization based on impact analysis
- Automated code suggestions when possible
- Concise summaries for better developer experience

### 8. PR Integration

Posts comments to the PR using provider-specific APIs:

```javascript
async function integrateWithPR(mergedReview, pr, repository) {
  // Prepare comments for the PR system
  const commentPayloads = [];

  // Add overall summary comment
  commentPayloads.push({
    body: formatSummaryComment(mergedReview.overallSummary, mergedReview.metadata),
    position: null, // Top-level comment
    isTopLevel: true,
  });

  // Add detailed comments for each group
  for (const group of mergedReview.commentGroups) {
    // Find appropriate location for comment
    const position = findBestCommentPosition(group.comments, pr.diff);

    // Create comment with code suggestion if available
    commentPayloads.push({
      body: formatDetailedComment(group.summary, group.comments, group.priority),
      position,
      suggestion: group.suggestion ? formatCodeSuggestion(group.suggestion) : null,
    });
  }

  // Post comments to appropriate PR system (GitHub, GitLab, etc)
  const provider = getProviderAPI(repository.provider);
  await provider.postComments(repository.externalId, pr.externalId, commentPayloads);

  // Store the review for feedback collection
  await db.reviews.insert({
    repositoryId: repository._id,
    prId: pr._id,
    externalPrId: pr.externalId,
    review: mergedReview,
    timestamp: Date.now(),
    status: 'completed',
    commentIds: commentPayloads.map(c => c.id),
  });
}
```

#### Key Features:

- Multi-provider support (GitHub, GitLab, Bitbucket)
- Smart positioning of comments
- Formatted comments with appropriate severity indicators
- Code suggestions when appropriate

### 9. Feedback System

Collects developer feedback to improve future reviews:

```javascript
async function processFeedback(prId, feedback) {
  // Retrieve the original review
  const review = await db.reviews.findOne({ externalPrId: prId });

  // Record feedback for each comment
  for (const commentFeedback of feedback.commentFeedback) {
    await db.reviewFeedback.insert({
      reviewId: review._id,
      commentId: commentFeedback.commentId,
      isHelpful: commentFeedback.isHelpful,
      action: commentFeedback.action, // accepted, rejected, ignored
      developerNotes: commentFeedback.notes,
      timestamp: Date.now(),
    });
  }

  // Track suggestion acceptance
  for (const suggestionFeedback of feedback.suggestionFeedback) {
    await db.suggestionFeedback.insert({
      reviewId: review._id,
      suggestionId: suggestionFeedback.suggestionId,
      accepted: suggestionFeedback.accepted,
      modified: suggestionFeedback.modified,
      finalCode: suggestionFeedback.finalCode,
      timestamp: Date.now(),
    });
  }

  // Update pattern effectiveness metrics
  await updatePatternEffectiveness(review, feedback);

  return {
    status: 'success',
    message: 'Feedback recorded successfully',
  };
}
```

#### Key Features:

- Detailed tracking of comment and suggestion feedback
- Support for different feedback types (helpful, accepted, rejected)
- Collection of developer notes for continuous improvement
- Integration with learning pipeline

### 10. Learning Pipeline

Continuously improves the system based on feedback:

```javascript
async function continuousLearningPipeline() {
  while (true) {
    // Get recent feedback data
    const recentFeedback = await db.reviewFeedback.find({
      timestamp: { $gt: Date.now() - 30 * 24 * 60 * 60 * 1000 }, // Last 30 days
    });

    // Group by pattern types and analyze effectiveness
    const patternEffectiveness = analyzePatternEffectiveness(recentFeedback);

    // Update pattern weights based on effectiveness
    for (const pattern of patternEffectiveness) {
      await db.patterns.update(
        { _id: pattern.patternId },
        {
          $set: {
            weight: pattern.newWeight,
            effectivenessScore: pattern.score,
            lastUpdated: Date.now(),
          },
          $inc: { usageCount: pattern.usageCount },
        }
      );
    }

    // Retrain specialized models if needed
    const shouldRetrain = analyzeFeedbackForRetraining(recentFeedback);
    if (shouldRetrain) {
      await retrainSpecializedModels(recentFeedback);
    }

    // Wait before next iteration
    await sleep(LEARNING_INTERVAL);
  }
}
```

#### Key Features:

- Continuous improvement based on developer feedback
- Pattern effectiveness tracking and weight adjustment
- Periodic model retraining with feedback data
- Usage statistics for pattern refinement

## Implementation Guidelines

### Data Storage Strategy

- **Vector Store**: Pinecone or Milvus for efficient vector similarity search
- **Operational Data**: Convex or MongoDB for review data and metadata
- **Historical Data**: Time-series optimized storage for historical trends

### Embedding Strategy

- **Code Unit Embeddings**: Generate embeddings at the semantic unit level (function, class, method)
- **Context-Aware Embeddings**: Include surrounding context in embedding generation
- **Multi-Modal Embeddings**: Different embedding models for different purposes (structure, security, performance)

### Performance Optimization

- **Parallel Processing**: Process multiple semantic units concurrently
- **Caching Layer**: Cache embeddings, dependency graphs, and common patterns
- **Prioritization**: Focus intensive analysis on high-impact or complex code
- **Batch Processing**: Group LLM requests for efficiency

### Security Considerations

- **Code Isolation**: Process code in isolated environments
- **Data Minimization**: Only store necessary repository data
- **Token Management**: Secure handling of access tokens
- **Permission Verification**: Ensure users only access authorized repositories

## Deployment Architecture

```
┌────────────────────────────────────────────────────────────┐
│                   API Gateway & Auth Layer                  │
└────────────────────────────────────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
┌────────────────────────┐    ┌────────────────────────┐
│ Repository Integration  │    │   Webhook Handlers     │
└────────────────────────┘    └────────────────────────┘
                │                          │
                └──────────────┬───────────┘
                               ▼
┌────────────────────────────────────────────────────────────┐
│                      Event Queue                           │
└────────────────────────────────────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
┌────────────────────────┐    ┌────────────────────────┐
│   Processing Workers   │    │    Learning Workers    │
└────────────────────────┘    └────────────────────────┘
        │         │                       │
        │         │                       │
        ▼         ▼                       ▼
┌────────────────────────────────────────────────────────────┐
│                   Shared Data Layer                        │
├────────────────┬─────────────────┬────────────────────────┤
│  Vector Store  │ Operational DB  │    Historical DB       │
└────────────────┴─────────────────┴────────────────────────┘
```

## Production Considerations

### Scaling

- Horizontal scaling of processing workers for high PR volume
- Separate processing pipelines for different repository sizes
- Auto-scaling based on queue depth and processing time

### Monitoring

- Track review quality metrics over time
- Monitor LLM response times and quality
- Alert on pattern detection failures
- Dashboard for effectiveness by repository and team

### Cost Management

- Tiered approach to minimize LLM usage
- Caching of common patterns and embeddings
- Batch processing for efficiency
- Flexible deployment options based on repository size

## Future Enhancements

1. **Team-Specific Learning**: Custom models trained on team-specific patterns
2. **Cross-Repository Intelligence**: Learn patterns across multiple repositories
3. **Security Vulnerability Database**: Integration with CVE and other security databases
4. **Automated Fixes**: Generate and test fixes for common issues
5. **IDE Integration**: Provide real-time feedback during development
6. **Code Quality Trends**: Track quality metrics over time with actionable insights
