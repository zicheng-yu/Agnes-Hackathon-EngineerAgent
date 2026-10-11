export function documentPageCount(document) {
  if (document?.mime?.startsWith('image/')) return 1;
  return document?.pageCount ?? document?.pages?.length;
}

export function drawingInputError(document, pages) {
  if (!document || document.error) return '图纸未能成功读取，请重新上传可打开的 PDF 或图片。';
  if (!['application/pdf','image/png','image/jpeg','image/webp'].includes(document.mime)) return '视觉重建请上传 PDF 或图片。';
  if (!Array.isArray(pages) || !pages.length || pages.length > 4 || pages.some(n => !Number.isInteger(n) || n < 1) || new Set(pages).size !== pages.length) return '每次请选择 1–4 个不重复的有效图纸页码。';
  const count = documentPageCount(document);
  if (!Number.isInteger(count) || count < 1) return '无法确定图纸页数，请重新上传图纸。';
  if (pages.some(n => n > count)) return `图纸共有 ${count} 页，请选择范围内的页码。`;
  return '';
}
