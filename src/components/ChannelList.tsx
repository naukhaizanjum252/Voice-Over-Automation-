'use client';

import type { ChannelStats } from '@/types';
import ChannelCard from './ChannelCard';

interface Props {
  stats: ChannelStats[];
  onRefresh: () => void;
}

export default function ChannelList({ stats, onRefresh }: Props) {
  return (
    <div className="grid gap-4">
      {stats.map((s, i) => (
        <div key={s.channel.id} className="fade-up" style={{ animationDelay: `${i * 60}ms` }}>
          <ChannelCard stats={s} onRefresh={onRefresh} />
        </div>
      ))}
    </div>
  );
}
