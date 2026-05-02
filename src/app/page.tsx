'use client';

import { useState, useEffect, useCallback } from 'react';
import ChannelForm from '@/components/ChannelForm';
import ChannelList from '@/components/ChannelList';
import StatsOverview from '@/components/StatsOverview';
import type { ChannelStats } from '@/types';

export default function Dashboard() {
  const [stats, setStats] = useState<ChannelStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [runningAll, setRunningAll] = useState(false);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/channel/list');
      if (res.ok) setStats(await res.json());
    } catch (err) {
      console.error('Failed to fetch channels:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll faster (5s) when cards are actively processing, otherwise every 30s
  const hasProcessing = stats.some((s) => s.processing > 0);

  useEffect(() => {
    fetchChannels();
    const interval = setInterval(fetchChannels, hasProcessing ? 5000 : 30000);
    return () => clearInterval(interval);
  }, [fetchChannels, hasProcessing]);

  const totalProcessed = stats.reduce((a, s) => a + s.total, 0);
  const totalCompleted = stats.reduce((a, s) => a + s.completed, 0);
  const totalFailed = stats.reduce((a, s) => a + s.failed, 0);
  const totalProcessing = stats.reduce((a, s) => a + s.processing, 0);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header
        className="sticky top-0 z-50 border-b"
        style={{
          borderColor: 'var(--border)',
          background: 'rgba(248, 249, 251, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div className="max-w-6xl mx-auto px-6 h-[60px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: 'var(--accent)', boxShadow: 'var(--shadow-accent)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </div>
            <div>
              <h1 className="text-[15px] font-bold tracking-tight" style={{ color: 'var(--text)' }}>
                VoiceFlow
              </h1>
              <p className="text-[11px] font-medium -mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Trello Script Automation
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={fetchChannels}
              className="p-2 rounded-lg t"
              style={{ color: 'var(--text-muted)' }}
              title="Refresh"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 16h5v5" />
              </svg>
            </button>
            {stats.length > 0 && (
              <button
                onClick={async () => {
                  setRunningAll(true);
                  try {
                    await fetch('/api/channel/run-all', { method: 'POST' });
                    fetchChannels();
                  } catch (err) { console.error('Run all failed:', err); }
                  finally { setRunningAll(false); }
                }}
                disabled={runningAll}
                className="h-9 px-3.5 rounded-xl text-[12px] font-bold t flex items-center gap-1.5 disabled:opacity-40 border"
                style={{
                  borderColor: 'var(--success)',
                  color: runningAll ? '#fff' : 'var(--success)',
                  background: runningAll ? 'var(--success)' : 'transparent',
                }}
              >
                {runningAll ? (
                  <>
                    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    Processing...
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    Run All
                  </>
                )}
              </button>
            )}
            <button
              onClick={() => setShowForm(!showForm)}
              className="h-9 px-4 rounded-xl text-[13px] font-semibold t flex items-center gap-2"
              style={{
                background: showForm ? 'var(--surface-2)' : 'var(--accent)',
                color: showForm ? 'var(--text-secondary)' : '#fff',
                boxShadow: showForm ? 'var(--shadow-sm)' : 'var(--shadow-accent)',
              }}
            >
              {showForm ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  Cancel
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
                  New Channel
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-7">
        {/* Stats */}
        <StatsOverview
          channels={stats.length}
          processed={totalProcessed}
          completed={totalCompleted}
          failed={totalFailed}
          processing={totalProcessing}
          loading={loading}
        />

        {/* Form */}
        {showForm && (
          <div className="mt-7 fade-up">
            <ChannelForm
              onCreated={() => { fetchChannels(); setShowForm(false); }}
              onCancel={() => setShowForm(false)}
            />
          </div>
        )}

        {/* Channels */}
        <div className="mt-7">
          <h2 className="text-[15px] font-bold mb-4" style={{ color: 'var(--text)' }}>
            Channels
          </h2>

          {loading ? (
            <div className="grid gap-4">
              {[1, 2].map((i) => (
                <div key={i} className="h-[140px] shimmer" />
              ))}
            </div>
          ) : stats.length === 0 ? (
            <div
              className="text-center py-16 rounded-2xl border-2 border-dashed"
              style={{ borderColor: 'var(--border)' }}
            >
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
                style={{ background: 'var(--surface-2)' }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)' }}>
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M12 8v8M8 12h8" />
                </svg>
              </div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                No channels yet
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Create your first channel to start generating voiceovers
              </p>
              <button
                onClick={() => setShowForm(true)}
                className="mt-5 h-9 px-5 rounded-xl text-[13px] font-semibold t"
                style={{ background: 'var(--accent)', color: '#fff', boxShadow: 'var(--shadow-accent)' }}
              >
                Get Started
              </button>
            </div>
          ) : (
            <ChannelList stats={stats} onRefresh={fetchChannels} />
          )}
        </div>
      </main>
    </div>
  );
}
