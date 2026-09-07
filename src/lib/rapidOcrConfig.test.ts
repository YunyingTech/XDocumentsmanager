import { describe, expect, it } from 'vitest';
import { DEFAULT_RAPID_OCR_WORKERS, MAX_RAPID_OCR_WORKERS, rapidWorkerCountValue } from './rapidOcrConfig';

describe('shared RapidOCR concurrency configuration', () => {
  it('keeps the default at 3 and raises the maximum to 256', () => {
    expect(DEFAULT_RAPID_OCR_WORKERS).toBe(3);
    expect(MAX_RAPID_OCR_WORKERS).toBe(256);
  });
  it.each([
    ['256', 256], ['257', 256], ['99', 99], ['8', 8], ['1', 1],
    ['0', 1], ['-10', 1], ['12.9', 12], ['', 3], ['invalid', 3],
    [null, 3], [undefined, 3], [Infinity, 3], [NaN, 3],
  ])('normalizes %s to %s in settings and the scheduler', (value, expected) => {
    expect(rapidWorkerCountValue(value)).toBe(expected);
  });
});
