// ABOUTME: Search query parser for NIP-50 with custom extensions
// ABOUTME: Parses search strings into structured queries with filters

import { ParsedSearchQuery, SearchEntityType } from './types';

/**
 * Parses a search query string into structured components
 * Supports NIP-50 search with custom extensions:
 * - type:user, type:video, etc. - Entity type filter
 * - author:pubkey - Author filter
 * - kind:N - Event kind filter
 * - #hashtag - Hashtag filter
 * - min_likes:N - Minimum likes threshold
 * - min_loops:N - Minimum loops threshold
 * - since:timestamp - Minimum timestamp
 * - until:timestamp - Maximum timestamp
 *
 * @param query - Raw search query string
 * @returns Parsed query with terms and filters
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    raw: query,
    terms: [],
    filters: {}
  };

  const tokens = query.split(/\s+/);

  for (const token of tokens) {
    if (!token) continue;

    if (token.startsWith('type:')) {
      parsed.type = token.substring(5) as SearchEntityType;
    } else if (token.startsWith('author:')) {
      parsed.filters.author = token.substring(7);
    } else if (token.startsWith('kind:')) {
      const kind = parseInt(token.substring(5));
      if (!isNaN(kind)) {
        parsed.filters.kinds = [kind];
      }
    } else if (token.startsWith('#')) {
      if (!parsed.filters.hashtags) parsed.filters.hashtags = [];
      parsed.filters.hashtags.push(token.substring(1));
    } else if (token.startsWith('min_likes:')) {
      const val = parseInt(token.substring(10));
      if (!isNaN(val)) {
        parsed.filters.min_likes = val;
      }
    } else if (token.startsWith('min_loops:')) {
      const val = parseInt(token.substring(10));
      if (!isNaN(val)) {
        parsed.filters.min_loops = val;
      }
    } else if (token.startsWith('since:')) {
      const val = parseInt(token.substring(6));
      if (!isNaN(val)) {
        parsed.filters.since = val;
      }
    } else if (token.startsWith('until:')) {
      const val = parseInt(token.substring(6));
      if (!isNaN(val)) {
        parsed.filters.until = val;
      }
    } else {
      // Regular search term
      parsed.terms.push(token);
    }
  }

  return parsed;
}

/**
 * Builds an FTS5 query string from search terms
 * Applies prefix matching for all terms
 *
 * @param terms - Array of search terms
 * @returns FTS5 query string with OR operator
 */
export function buildFTSQuery(terms: string[]): string {
  if (terms.length === 0) return '';
  // Build FTS5 query with prefix matching
  return terms.map(t => `${t}*`).join(' OR ');
}
