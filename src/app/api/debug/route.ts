import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '@/lib/supabase';
import { generateScript, type ScriptGenConfig } from '@/services/scriptService';
import { fetchPrimaryDocTexts } from '@/services/scriptProcessingService';
import type { Channel } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const test = searchParams.get('test') || 'all';

  const results: Record<string, unknown> = {};

  // ── WellFlow (Anthropic-compatible proxy) Test (via SDK) ──
  if (test === 'all' || test === 'wellflow' || test === 'anthropic') {
    const wellflowKey = process.env.WELLFLOW_API_KEY || '';
    results['wellflow_key'] = wellflowKey
      ? `${wellflowKey.slice(0, 12)}...${wellflowKey.slice(-4)} (${wellflowKey.length} chars)`
      : 'NOT SET';

    if (wellflowKey) {
      // Test the models available in the Script Model dropdown
      const models = [
        'claude-sonnet-4.6',
        'claude-opus-4.6',
        'claude-opus-5',
      ];

      const client = new Anthropic({
        apiKey: wellflowKey,
        baseURL: process.env.WELLFLOW_BASE_URL || 'https://api.wellflow.dev',
      });

      for (const model of models) {
        try {
          const message = await client.messages.create({
            model,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Say hi' }],
          });
          results[`wellflow_${model}`] = {
            status: 'OK',
            response: message.content[0],
            usage: message.usage,
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          results[`wellflow_${model}`] = { status: 'FAILED', error: errMsg.slice(0, 200) };
        }
      }
    }
  }


  // ── AI84 Tests ──
  const ai84Key = process.env.AI84_API_KEY || '';
  if (ai84Key) {
    const AI84_BASE = 'https://api.ai84.pro';
    const ai84Headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'xi-api-key': ai84Key,
    };

    // Test voice endpoints — probe many patterns to find cloned voices
    const voiceEndpoints = [
      '/v1/minimax/voices',
      '/v1/minimax/voices?type=cloned',
      '/v1/minimax/voices?category=cloned',
      '/v1/minimax/voices?filter=cloned',
      '/v1/minimax/voices/cloned',
      '/v1/minimax/voices/mine',
      '/v1/minimax/voices/user',
      '/v1/minimax/cloned-voices',
      '/v1/minimax/voices?page=1&page_size=100',
      '/v1/minimax/voices?page=2&page_size=100',
      '/v1/minimax/voices?page=3&page_size=100',
      // ElevenLabs-compatible paths
      '/v1/voices',
      '/v1/voices?show_legacy=true',
      '/v1/voices/cloned',
      // Direct minimax paths
      '/v1/minimax/voice/list',
      '/v1/minimax/voice-clone/list',
      '/v1/minimax/text-to-speech/voices',
    ];

    const voiceResults: Record<string, unknown> = {};
    for (const ep of voiceEndpoints) {
      try {
        const r = await fetch(`${AI84_BASE}${ep}`, {
          headers: ai84Headers,
          signal: AbortSignal.timeout(10000),
        });
        const text = await r.text();
        let data: unknown = text.slice(0, 1000);
        try { data = JSON.parse(text); } catch { /* not json */ }
        const obj = data as Record<string, unknown>;
        // Try many possible array fields
        const dataArr = Array.isArray(obj.data) ? obj.data
          : Array.isArray(obj.voices) ? obj.voices
          : Array.isArray(obj.items) ? obj.items
          : Array.isArray(obj.results) ? obj.results
          : Array.isArray(data) ? data as unknown[]
          : null;
        const voiceNames = dataArr
          ? (dataArr as Record<string, unknown>[]).map((v) => ({
              name: v.name,
              id: v.canonical_voice_id ?? v.voice_id ?? v.id,
              category: v.category,
            }))
          : [];
        voiceResults[ep] = {
          status: r.status,
          total: obj.total ?? (dataArr ? dataArr.length : '?'),
          page: obj.page,
          page_size: obj.page_size,
          voiceCount: dataArr?.length ?? '?',
          allVoiceNames: voiceNames,
          rawKeys: obj ? Object.keys(obj) : [],
          sample: JSON.stringify(data).slice(0, 500),
        };
      } catch (err) {
        voiceResults[ep] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    results['ai84_voices'] = voiceResults;

    // Test poll response shape (if there's an active job from the current test)
    try {
      const testRes = await fetch(`${AI84_BASE}/v1/minimax/text-to-speech/async`, {
        method: 'POST',
        headers: ai84Headers,
        body: JSON.stringify({
          canonical_voice_id: 'test_voice',
          text: 'Hello test.',
          model: 'speech-2.6-turbo',
        }),
        signal: AbortSignal.timeout(10000),
      });
      const testData = await testRes.json();
      results['ai84_generate'] = { status: testRes.status, body: testData };

      if (testData.job_id) {
        await new Promise((r) => setTimeout(r, 3000));
        const pollRes = await fetch(`${AI84_BASE}/v1/minimax/text-to-speech/async/${testData.job_id}`, {
          headers: ai84Headers,
          signal: AbortSignal.timeout(10000),
        });
        const pollText = await pollRes.text();
        let pollData: unknown = pollText;
        try { pollData = JSON.parse(pollText); } catch { /* not json */ }
        results['ai84_poll'] = { status: pollRes.status, body: pollData };
      }
    } catch (err) {
      results['ai84_generate'] = { error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    results['ai84'] = 'AI84_API_KEY not set';
  }

  // ── Script Generation Test ──
  // Usage: /api/debug?test=script&title=Your+Title+Here&channel=test
  if (test === 'script') {
    const title = searchParams.get('title') || 'Test Topic';
    const channelName = searchParams.get('channel') || 'test';

    try {
      // Fetch channel by name
      const { data: channel, error: chErr } = await supabase
        .from('channels')
        .select('*')
        .ilike('name', channelName)
        .single();

      if (chErr || !channel) {
        return NextResponse.json({ error: `Channel "${channelName}" not found`, details: chErr?.message }, { status: 404 });
      }

      const ch = channel as Channel;

      // Fetch primary docs
      const primaryDocTexts = await fetchPrimaryDocTexts();

      // Fetch model setting
      const { data: modelSetting } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'script_model')
        .single();
      const model = modelSetting?.value || undefined;

      // Build config (same as processScriptCard does)
      const config: ScriptGenConfig = {
        primaryDocTexts,
        niche: ch.niche,
        format: ch.format,
        length: ch.length,
        characterCount: ch.character_count,
        output: ch.output,
        note: ch.note,
      };

      // Generate script
      const scriptText = await generateScript(config, title, model);

      return NextResponse.json({
        channel: ch.name,
        model: model || 'claude-sonnet-4.6 (default)',
        title,
        primaryDocs: primaryDocTexts.length,
        scriptLength: scriptText.length,
        scriptPreview: scriptText.slice(0, 500),
        fullScript: scriptText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  return NextResponse.json(results, { status: 200 });
}
