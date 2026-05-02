const MAX_CHUNK_SIZE = 5000; // characters

/**
 * Splits text into chunks of ≤ MAX_CHUNK_SIZE characters.
 * Prefers paragraph boundaries; falls back to hard splits.
 */
export function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK_SIZE) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    // If a single paragraph exceeds the limit, hard-split it
    if (para.length > MAX_CHUNK_SIZE) {
      // Flush current buffer first
      if (current.length > 0) {
        chunks.push(current.trim());
        current = '';
      }
      // Hard-split the oversized paragraph
      chunks.push(...hardSplit(para));
      continue;
    }

    // Check if adding this paragraph would exceed limit
    const tentative = current.length === 0 ? para : `${current}\n\n${para}`;
    if (tentative.length <= MAX_CHUNK_SIZE) {
      current = tentative;
    } else {
      // Flush current and start new chunk
      if (current.length > 0) {
        chunks.push(current.trim());
      }
      current = para;
    }
  }

  // Flush remaining
  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Hard-splits text at sentence boundaries, falling back to word boundaries.
 */
function hardSplit(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_CHUNK_SIZE) {
    let splitIdx = -1;

    // Try to split at sentence boundary within limit
    const segment = remaining.slice(0, MAX_CHUNK_SIZE);
    const sentenceEnd = Math.max(
      segment.lastIndexOf('. '),
      segment.lastIndexOf('! '),
      segment.lastIndexOf('? ')
    );

    if (sentenceEnd > MAX_CHUNK_SIZE * 0.3) {
      splitIdx = sentenceEnd + 2; // include the punctuation + space
    } else {
      // Fall back to word boundary
      const lastSpace = segment.lastIndexOf(' ');
      splitIdx = lastSpace > 0 ? lastSpace + 1 : MAX_CHUNK_SIZE;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
