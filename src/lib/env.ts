export const env = {
  trello: {
    apiKey: process.env.TRELLO_API_KEY!,
    token: process.env.TRELLO_TOKEN!,
  },
  labs69: {
    apiKey: process.env.LABS69_API_KEY!,
  },
  ai84: {
    apiKey: process.env.AI84_API_KEY || "",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  tts: {
    // Which TTS provider to try first: "ai84" (default) or "69labs".
    // The other provider is used as automatic fallback.
    primaryProvider: process.env.TTS_PRIMARY_PROVIDER || "ai84",
  },
  supabase: {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  },
  cronSecret: process.env.CRON_SECRET!,
};
