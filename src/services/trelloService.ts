import { env } from '@/lib/env';
import type { TrelloBoard, TrelloList, TrelloCard, TrelloAttachment } from '@/types';

const BASE = 'https://api.trello.com/1';

function authParams(): string {
  return `key=${encodeURIComponent(env.trello.apiKey)}&token=${encodeURIComponent(env.trello.token)}`;
}

async function trelloFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${separator}${authParams()}`;

  try {
    const res = await fetch(url, {
      ...options,
      cache: 'no-store',
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trello API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  } catch (err) {
    // Enrich error message for debugging
    if (err instanceof Error) {
      const cause = (err as unknown as Record<string, unknown>).cause;
      const causeMsg = cause instanceof Error ? ` (cause: ${cause.message})` : '';
      throw new Error(`Trello fetch failed for ${path}: ${err.message}${causeMsg}`);
    }
    throw err;
  }
}

// ── Public API ──

export async function getBoards(): Promise<TrelloBoard[]> {
  return trelloFetch<TrelloBoard[]>('/members/me/boards?fields=name,url');
}

export async function getLists(boardId: string): Promise<TrelloList[]> {
  if (!boardId || boardId === 'undefined' || boardId === 'null') {
    throw new Error('Invalid boardId provided');
  }
  return trelloFetch<TrelloList[]>(
    `/boards/${encodeURIComponent(boardId)}/lists?fields=name,idBoard`
  );
}

export async function getCardsInList(listId: string): Promise<TrelloCard[]> {
  return trelloFetch<TrelloCard[]>(
    `/lists/${encodeURIComponent(listId)}/cards?fields=name,desc,idList&attachments=true`
  );
}

export async function downloadAttachment(url: string): Promise<Buffer> {
  // Trello attachment URLs may be pre-signed S3 URLs (already contain auth)
  // or Trello-hosted URLs that need key/token. Try as-is first, then with auth.
  const fetchOpts: RequestInit = { cache: 'no-store', signal: AbortSignal.timeout(60000) };

  // Attempt 1: URL as-is (handles pre-signed S3 URLs)
  let res = await fetch(url, fetchOpts);

  if (res.status === 401 || res.status === 403) {
    // Attempt 2: Add Trello key/token as query params
    const separator = url.includes('?') ? '&' : '?';
    res = await fetch(`${url}${separator}${authParams()}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    });
  }

  if (res.status === 401 || res.status === 403) {
    // Attempt 3: Use Authorization header instead
    res = await fetch(url, {
      ...fetchOpts,
      headers: { Authorization: `OAuth oauth_consumer_key="${env.trello.apiKey}", oauth_token="${env.trello.token}"` },
    });
  }

  if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function uploadAttachmentToCard(
  cardId: string,
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string = 'audio/mpeg'
): Promise<TrelloAttachment> {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), fileName);
  formData.append('name', fileName);

  const url = `${BASE}/cards/${encodeURIComponent(cardId)}/attachments?${authParams()}`;
  const res = await fetch(url, { method: 'POST', body: formData });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upload attachment: ${res.status} ${text}`);
  }
  return res.json() as Promise<TrelloAttachment>;
}

export function getScriptAttachment(
  attachments: TrelloAttachment[]
): TrelloAttachment | null {
  const allowedExtensions = ['.txt', '.doc', '.docx', '.pdf'];
  return (
    attachments.find((att) => {
      const name = att.name.toLowerCase();
      return allowedExtensions.some((ext) => name.endsWith(ext));
    }) ?? null
  );
}
