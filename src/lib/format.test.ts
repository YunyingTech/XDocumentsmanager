import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatFileSize, relativePath } from './format';

describe('format helpers', () => {
  it('formats byte boundaries with stable units', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(999)).toBe('999 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatFileSize(1024 ** 4)).toBe('1.0 TB');
  });

  it('returns a placeholder for missing or invalid dates', () => {
    expect(formatDate(null, 'en-US')).toBe('-');
    expect(formatDate('not-a-date', 'en-US')).toBe('-');
    expect(formatDateTime('', 'en-US')).toBe('-');
    expect(formatDateTime('Invalid Date', 'en-US')).toBe('-');
  });

  it('formats valid dates instead of exposing Invalid Date', () => {
    expect(formatDate('2026-07-23T00:00:00Z', 'en-US')).toContain('2026');
    expect(formatDateTime('2026-07-23T00:00:00Z', 'zh-CN')).not.toBe('-');
  });

  it('creates a relative path for slash and backslash roots', () => {
    expect(relativePath('C:\\Documents\\reports\\a.pdf', 'C:\\Documents')).toBe('reports\\a.pdf');
    expect(relativePath('/data/reports/a.pdf', '/data')).toBe('reports/a.pdf');
    expect(relativePath('D:\\other\\a.pdf', 'C:\\Documents')).toBe('D:\\other\\a.pdf');
  });
});
