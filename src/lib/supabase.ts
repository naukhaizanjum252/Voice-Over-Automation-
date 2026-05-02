import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supabase: SupabaseClient | null = null;

/**
 * Server-side Supabase client (lazy-initialized to avoid build-time errors
 * when env vars aren't available).
 */
export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    }
    // Decode JWT payload to verify role
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString());
      console.log('[supabase] URL:', url);
      console.log('[supabase] Key role:', payload.role, '| ref:', payload.ref);
    } catch {
      console.log('[supabase] Key (not JWT):', key.slice(0, 10) + '...');
    }
    _supabase = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, cache: 'no-store' }),
      },
    });
  }
  return _supabase;
}

// Re-export as `supabase` getter for convenience — use as: supabase (it's a getter)
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabase() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
