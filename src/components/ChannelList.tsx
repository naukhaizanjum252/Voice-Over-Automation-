'use client';

import { useState } from 'react';
import type { ChannelStats } from '@/types';
import ChannelCard from './ChannelCard';

interface Props {
  stats: ChannelStats[];
  onRefresh: () => void;
  onEdit?: (channelId: string) => void;
}

export default function ChannelList({ stats, onRefresh, onEdit }: Props) {
  const [search, setSearch] = useState('');

  const q = search.toLowerCase().trim();
  const filtered = q
    ? stats.filter((s) =>
        s.channel.name.toLowerCase().includes(q) ||
        s.boardName.toLowerCase().includes(q) ||
        s.listNames.some((l) => l.toLowerCase().includes(q))
      )
    : stats;

  return (
    <div>
      {stats.length > 1 && (
        <div className="relative mb-4">
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-3.5 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-muted)' }}
          >
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search channels..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-10 pl-10 pr-4 rounded-xl text-[13px] t outline-none"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border-light)',
              color: 'var(--text)',
            }}
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-center py-8 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          No channels matching &quot;{search}&quot;
        </p>
      ) : (
        <div className="grid gap-4">
          {filtered.map((s, i) => (
            <div key={s.channel.id} className="fade-up" style={{ animationDelay: `${i * 60}ms` }}>
              <ChannelCard stats={s} onRefresh={onRefresh} onEdit={onEdit} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
