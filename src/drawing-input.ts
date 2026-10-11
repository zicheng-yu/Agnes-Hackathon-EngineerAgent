import type { DocumentRecord } from './types';
export function drawingPageCount(document: DocumentRecord | null): number | undefined {
  return document?.mime?.startsWith('image/') ? 1 : document?.pageCount ?? document?.pages?.length;
}
export function drawingInputError(document: DocumentRecord | null, pages: number[]): string {
  if (!document) return '请先上传图纸。';
  if (document.error) return '图纸未能成功读取，请重新上传。';
  if (!pages.length || pages.length > 4 || pages.some(n => !Number.isInteger(n) || n < 1) || new Set(pages).size !== pages.length) return '请选择 1–4 个不重复的有效页码。';
  const count = drawingPageCount(document);
  // Managed uploads may be parsed by the runner later; enforce known bounds here.
  if (count && pages.some(n => n > count)) return `图纸共有 ${count} 页，请选择范围内的页码。`;
  return '';
}
