/**
 * Keyword-based memory relevance scoring.
 *
 * Uses Jaccard similarity on tokenized query and memory text (name + description)
 * to score relevance. Bonus multiplier for exact phrase matches.
 *
 * Provider-agnostic: no LLM calls, pure text processing. Deterministic and fast.
 */

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into lowercase word tokens.
 * Strips punctuation and splits on whitespace.
 * Filters single-char tokens (mostly noise) unless they are notable (e.g., "c", "go", "x").
 */
export function tokenize(text: string): string[] {
  // Lowercase and normalize whitespace
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')  // Replace punctuation with space
    .replace(/\s+/g, ' ')        // Collapse whitespace
    .trim();

  if (!normalized) return [];

  return normalized
    .split(' ')
    .filter(t => t.length > 1); // Drop single-char tokens
}

// ---------------------------------------------------------------------------
// Jaccard similarity
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard similarity between two token sets.
 *
 * Jaccard = |intersection| / |union|
 *
 * Returns 0 for empty sets, 1 for identical sets.
 */
export function jaccardSimilarity(
  tokensA: Set<string>,
  tokensB: Set<string>,
): number {
  if (tokensA.size === 0 && tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  // Union = |A| + |B| - |intersection|
  const union = tokensA.size + tokensB.size - intersection;

  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Exact phrase bonus
// ---------------------------------------------------------------------------

/**
 * Check if any word from the query appears as-is in the target text.
 * Longer matches get higher bonuses.
 */
function phraseMatchBonus(query: string, target: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const targetLower = target.toLowerCase();
  let matches = 0;

  for (const token of queryTokens) {
    if (token.length < 3) continue; // Skip very short tokens
    if (targetLower.includes(token)) {
      matches++;
    }
  }

  if (matches === 0) return 0;

  // Bonus proportional to match ratio, max 0.5
  return Math.min(0.5, (matches / queryTokens.length) * 0.5);
}

// ---------------------------------------------------------------------------
// Memory relevance scoring
// ---------------------------------------------------------------------------

export interface MemoryWithText {
  name: string;
  description: string;
}

/**
 * Score how relevant a memory is to a user query.
 *
 * Algorithm:
 *   1. Tokenize both query and memory text (name + description)
 *   2. Compute Jaccard similarity → base score [0, 1]
 *   3. Add exact phrase match bonus → up to +0.5
 *   4. Normalize to [0, 1]
 *
 * @param query - The user's query text
 * @param memory - The memory's name and description
 * @returns Relevance score from 0 (irrelevant) to 1 (highly relevant)
 */
export function scoreMemoryRelevance(
  query: string,
  memory: MemoryWithText,
): number {
  const queryTokens = tokenize(query);
  const querySet = new Set(queryTokens);

  // Combine name and description for the memory text
  const memoryText = `${memory.name} ${memory.description}`;
  const memoryTokens = tokenize(memoryText);
  const memorySet = new Set(memoryTokens);

  // Base Jaccard score
  const baseScore = jaccardSimilarity(querySet, memorySet);

  // Exact phrase match bonus
  const bonus = phraseMatchBonus(query, memoryText);

  // Combine and clamp to [0, 1]
  return Math.min(1, baseScore + bonus);
}

/**
 * Rank an array of memories by relevance to the query.
 * Returns sorted array (highest score first), filtered to minScore threshold.
 */
export function rankMemories<T extends MemoryWithText>(
  query: string,
  memories: T[],
  minScore: number = 0.05,
): Array<{ memory: T; score: number }> {
  if (!query.trim() || memories.length === 0) return [];

  const scored = memories.map(memory => ({
    memory,
    score: scoreMemoryRelevance(query, memory),
  }));

  // Filter by minimum score and sort descending
  return scored
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
