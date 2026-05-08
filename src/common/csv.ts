/**
 * Minimal RFC 4180-style CSV serializer. Wraps fields containing
 * commas, quotes, or newlines in double quotes; escapes inner quotes
 * by doubling them. Returns a CSV string with `\r\n` line endings so
 * Excel opens it cleanly.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [csvRow(headers), ...rows.map(csvRow)];
  // BOM so Excel recognises UTF-8 with Cyrillic-like glyphs.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
