/**
 * Append one keyword hashtag on the final line without changing the original prose.
 * Telegram captions are limited to 1024 UTF-16 units here (conservative for emoji).
 */
export function keywordTag(keyword: string): string {
  const name = String(keyword || '').trim().replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
  if (!name) throw new Error('关键词无法生成有效标签');
  return '#' + name;
}

export function appendKeywordTag(caption: string | undefined, keyword: string): string {
  const tag = keywordTag(keyword);
  let body = String(caption || '').trimEnd();
  // Repeated runs and duplicate trailing tag-only lines remain idempotent.
  while (body === tag || body.endsWith('\n' + tag)) {
    body = body.slice(0, body.length - tag.length).trimEnd();
  }
  const result = body ? body + '\n' + tag : tag;
  if (result.length > 1024) throw new Error('添加关键词标签后文案超过 1024 字符，请缩短文案');
  return result;
}

/** Only the caption-bearing records, or the first record of a captionless album. */
export function tagCaptionForMedia(media: { caption?: string; keyword: string }, isCaptionlessPrimary = false): string | undefined {
  return media.caption?.trim() || isCaptionlessPrimary
    ? appendKeywordTag(media.caption, media.keyword) : media.caption;
}
