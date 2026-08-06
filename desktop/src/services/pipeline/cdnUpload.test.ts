import { describe, expect, it } from 'vitest';
import { mimeFromExt } from './cdnUpload';

describe('mimeFromExt', () => {
  it.each([
    ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
    ['.docm', 'application/vnd.ms-word.document.macroEnabled.12'],
    ['.tif', 'image/tiff'],
    ['.tiff', 'image/tiff'],
  ])('maps %s to %s', (extension, expected) => {
    expect(mimeFromExt(extension)).toBe(expected);
    expect(mimeFromExt(extension.toUpperCase())).toBe(expected);
  });
});
