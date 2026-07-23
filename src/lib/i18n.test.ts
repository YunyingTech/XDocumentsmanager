import { describe, expect, it } from 'vitest';
import { translate } from './i18n';

describe('translations', () => {
  it('translates the OCR batch actions in both languages', () => {
    expect(translate('en', 'tasks.cancelAllOcr')).toBe('Cancel all OCR tasks');
    expect(translate('zh-CN', 'tasks.cancelAllOcr')).toBe('取消所有 OCR 任务');
    expect(translate('en', 'files.indexAndOcr')).toBe('Index and OCR');
    expect(translate('zh-CN', 'files.indexAndOcr')).toBe('索引并 OCR');
  });

  it('interpolates known values and preserves missing placeholders', () => {
    expect(translate('en', 'tasks.active', { count: 3 })).toBe('3 active');
    expect(translate('en', 'tasks.active')).toBe('{count} active');
  });

  it('keeps AI match metadata localized', () => {
    expect(translate('en', 'search.aiMatchHint', { model: 'gpt-test', terms: 'audit' }))
      .toContain('gpt-test');
    expect(translate('zh-CN', 'search.aiMatchedTerms')).toBe('AI 命中');
  });
});
