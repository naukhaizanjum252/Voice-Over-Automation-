import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const test = searchParams.get('test') || 'all';

  const results: Record<string, unknown> = {};

  // ── Anthropic API Test (via SDK) ──
  if (test === 'all' || test === 'anthropic') {
    const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
    results['anthropic_key'] = anthropicKey
      ? `${anthropicKey.slice(0, 12)}...${anthropicKey.slice(-4)} (${anthropicKey.length} chars)`
      : 'NOT SET';

    if (anthropicKey) {
      // Try multiple model IDs to find which one works
      const models = [
        'claude-sonnet-4-20250514',
        'claude-haiku-4-5-20251001',
        'claude-3-5-sonnet-20241022',
        'claude-3-haiku-20240307',
      ];

      const client = new Anthropic({ apiKey: anthropicKey });

      for (const model of models) {
        try {
          const message = await client.messages.create({
            model,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Say hi' }],
          });
          results[`anthropic_${model}`] = {
            status: 'OK',
            response: message.content[0],
            usage: message.usage,
          };
          break; // stop on first success
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          results[`anthropic_${model}`] = { status: 'FAILED', error: errMsg.slice(0, 200) };
        }
      }
    }
  }

  // ── 69 Labs TTS Test ──
  if (test === 'all' || test === 'tts') {
    const apiKey = process.env.LABS69_API_KEY!;
    const BASE = 'https://69labs.vip/api/v1';
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    try {
      const genRes = await fetch(`${BASE}/tts/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: 'Hello, this is a test.',
          voiceId: 'EXAVITQu4vr4xnSDxMaL',
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
        }),
      });

      const genText = await genRes.text();
      let genData: Record<string, unknown> = {};
      try { genData = JSON.parse(genText); } catch { /* not JSON */ }

      results['tts_generate'] = { status: genRes.status, body: genData };
    } catch (err) {
      results['tts_generate'] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return NextResponse.json(results, { status: 200 });
}
