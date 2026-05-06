import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const apiKey = process.env.LABS69_API_KEY!;
  const BASE = 'https://69labs.vip/api/v1';
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const results: Record<string, unknown> = {};

  // Test 1: Generate a short TTS job
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

    results['1_generate'] = {
      status: genRes.status,
      headers: Object.fromEntries(genRes.headers.entries()),
      body: genData,
      raw: genText.slice(0, 500),
    };

    // Test 2: If we got a job ID, poll status
    const jobId = genData.id ?? genData.jobId ?? genData.task_id ?? genData.ttsId;
    if (jobId) {
      // Poll 3 times with 3s gaps
      const polls = [];
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const statusRes = await fetch(`${BASE}/tts/status/${jobId}`, { headers });
        const statusText = await statusRes.text();
        let statusData = {};
        try { statusData = JSON.parse(statusText); } catch { /* not JSON */ }
        polls.push({
          poll: i + 1,
          status: statusRes.status,
          body: statusData,
          raw: statusText.slice(0, 500),
        });
      }
      results['2_status_polls'] = polls;

      // Test 3: Try download anyway
      try {
        const dlRes = await fetch(`${BASE}/tts/download/${jobId}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'audio/mpeg' },
        });
        results['3_download'] = {
          status: dlRes.status,
          contentType: dlRes.headers.get('content-type'),
          size: dlRes.headers.get('content-length'),
          body: dlRes.status !== 200 ? (await dlRes.text()).slice(0, 300) : `OK (${dlRes.headers.get('content-length')} bytes)`,
        };
      } catch (err) {
        results['3_download'] = err instanceof Error ? err.message : String(err);
      }
    }
  } catch (err) {
    results['1_generate'] = err instanceof Error ? err.message : String(err);
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

  return NextResponse.json(results, { status: 200 });
}
