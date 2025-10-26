// ABOUTME: Safe column maps - single source of truth for sortable and filterable video columns
// ABOUTME: Used by validation, query builder, and ranked list publisher to prevent SQL injection

/**
 * Sortable columns for video queries
 * Key: field name from client request
 * Value: actual SQL column name
 *
 * NOTE: reposts currently commented out until analytics populates this metric
 */
export const SORTABLE_COLUMNS: Record<string, string> = {
  loop_count: 'loop_count',
  likes: 'likes',
  views: 'views',
  comments: 'comments',
  avg_completion: 'avg_completion',
  created_at: 'created_at'
  // reposts: 'reposts'  // COMMENTED OUT until populated by analytics
};

/**
 * Columns that support int# numeric filtering
 * Subset of SORTABLE_COLUMNS (created_at uses since/until, not int#)
 *
 * NOTE: reposts currently commented out until analytics populates this metric
 */
export const INT_FILTERABLE_COLUMNS: Record<string, string> = {
  loop_count: 'loop_count',
  likes: 'likes',
  views: 'views',
  comments: 'comments',
  avg_completion: 'avg_completion'
  // reposts: 'reposts'  // COMMENTED OUT until populated by analytics
};

/**
 * Validate and normalize a sort field name
 * Returns the SQL column name if valid, defaults to 'created_at'
 *
 * @param field - Field name from client request (e.g., "loop_count")
 * @returns SQL column name (e.g., "loop_count") or "created_at" if invalid
 */
export function validateSortField(field?: string): string {
  if (!field) return 'created_at';
  return SORTABLE_COLUMNS[field] ?? 'created_at';
}

/**
 * Check if a column name is valid for int# filtering
 *
 * @param column - Column name from client request (e.g., "loop_count")
 * @returns true if column supports int# filtering, false otherwise
 */
export function validateIntColumn(column: string): boolean {
  return column in INT_FILTERABLE_COLUMNS;
}

/**
 * Get list of all sortable field names (for NIP-11 and error messages)
 */
export function getSortableFields(): string[] {
  return Object.keys(SORTABLE_COLUMNS);
}

/**
 * Get list of all int-filterable field names (for NIP-11 and error messages)
 */
export function getIntFilterableFields(): string[] {
  return Object.keys(INT_FILTERABLE_COLUMNS);
}
