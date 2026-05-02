import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const results: Record<string, unknown> = {};

  // Test 1: Direct REST API call with service role key
  try {
    const res = await fetch(`${url}/rest/v1/channels?select=*`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    results['REST service_role'] = { status: res.status, count: Array.isArray(data) ? data.length : 'not array', data };
  } catch (err) {
    results['REST service_role'] = err instanceof Error ? err.message : String(err);
  }

  // Test 2: Direct REST API call with anon key
  try {
    const res = await fetch(`${url}/rest/v1/channels?select=*`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    results['REST anon'] = { status: res.status, count: Array.isArray(data) ? data.length : 'not array', data };
  } catch (err) {
    results['REST anon'] = err instanceof Error ? err.message : String(err);
  }

  // Test 3: Check what tables exist
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    const text = await res.text();
    results['tables'] = { status: res.status, body: text.slice(0, 500) };
  } catch (err) {
    results['tables'] = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(results, { status: 200 });
}
