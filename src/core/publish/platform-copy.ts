export const SUBSTACK_SUBTITLE_MAX_CHARS = 120;
export const LINKEDIN_POST_MAX_CHARS = 3000;
export const LINKEDIN_BODY_MAX_CHARS = 2200;
const ABRUPT_ELLIPSIS_PATTERN = /(^|\s)\S*\.{3}(?:\s|$)/;

export function normalizePlatformCopy(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function hasAbruptEllipsis(value: string): boolean {
  return ABRUPT_ELLIPSIS_PATTERN.test(value);
}

function firstCompleteSentence(value: string, maxChars: number): string | null {
  const normalized = normalizePlatformCopy(value);
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char !== '.' && char !== '!' && char !== '?') continue;
    const next = normalized[i + 1] ?? '';
    const prev = normalized[i - 1] ?? '';
    if (char === '.' && /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) {
      continue;
    }
    if (next === '' || /\s/.test(next)) {
      const sentence = normalized.slice(0, i + 1);
      if (sentence.length <= maxChars && !hasAbruptEllipsis(sentence)) {
        return sentence;
      }
    }
  }
  return null;
}

export function fitNaturalCopy(
  value: string,
  maxChars: number,
  label: string,
  fallback?: string,
): string {
  const normalized = normalizePlatformCopy(value);
  if (normalized.length <= maxChars && !hasAbruptEllipsis(normalized)) return normalized;

  const sentence = firstCompleteSentence(normalized, maxChars);
  if (sentence) return sentence;

  const fallbackCopy = fallback ? normalizePlatformCopy(fallback) : '';
  if (fallbackCopy.length > 0 && fallbackCopy.length <= maxChars && !hasAbruptEllipsis(fallbackCopy)) {
    return fallbackCopy;
  }

  throw new Error(
    `${label} could not be fit within ${maxChars} characters without clipping. ` +
    'Shorten the draft frontmatter description, then re-run draft/evaluate before publishing.',
  );
}
