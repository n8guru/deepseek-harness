import type { AlignType, TableRow } from 'mdast'

/**
 * Shared rendered table width: pad short rows and omit overflow cells.
 * @param row - Parsed table row.
 * @param align - Column alignment, or null when no width is specified.
 * @returns Number of cells visible in this row.
 */
export function renderedTableCellCount(row: TableRow, align: readonly AlignType[] | null): number {
  return align === null ? row.children.length : align.length
}
