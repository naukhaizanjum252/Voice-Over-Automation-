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

  return NextResponse.json(results, { status: 200 });
}
