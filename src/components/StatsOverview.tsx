'use client';

export type StatsFilter = 'completed' | 'failed' | 'processing' | null;

interface Props {
  channels: number;
  processed: number;
  completed: number;
  failed: number;
  processing: number;
  loading: boolean;
  activeFilter?: StatsFilter;
  onFilter?: (filter: StatsFilter) => void;
}

const cards = [
  {
    key: 'channels',
    label: 'Channels',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      </svg>
    ),
    color: 'var(--accent)',
    bg: 'var(--accent-muted)',
  },
  {
    key: 'processed',
    label: 'Total Processed',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
    color: 'var(--text-secondary)',
    bg: 'var(--surface-2)',
  },
  {
    key: 'completed',
    label: 'Completed',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
    color: 'var(--success)',
    bg: 'var(--success-muted)',
  },
  {
    key: 'failed',
    label: 'Failed',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
    color: 'var(--danger)',
    bg: 'var(--danger-muted)',
  },
  {
    key: 'processing',
    label: 'In Progress',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    ),
    color: 'var(--warning)',
    bg: 'var(--warning-muted)',
  },
];

export default function StatsOverview({
  channels,
  processed,
  completed,
  failed,
  processing,
  loading,
  activeFilter,
  onFilter,
}: Props) {
  const values: Record<string, number> = { channels, processed, completed, failed, processing };
  const filterableKeys = ['completed', 'failed', 'processing'];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((card) => {
        const isFilterable = filterableKeys.includes(card.key);
        const isActive = activeFilter === card.key;

        return (
          <div
            key={card.key}
            onClick={() => {
              if (!isFilterable || !onFilter) return;
              onFilter(isActive ? null : (card.key as StatsFilter));
            }}
            className={`rounded-2xl border p-4 t ${isFilterable ? 'cursor-pointer hover:opacity-80' : ''}`}
            style={{
              background: 'var(--surface)',
              borderColor: isActive ? card.color : 'var(--border-light)',
              boxShadow: isActive ? `0 0 0 1px ${card.color}` : 'var(--shadow-sm)',
            }}
          >
            <div className="flex items-center gap-2.5 mb-3.5">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: card.bg, color: card.color }}
              >
                {card.icon}
              </div>
              {isActive && (
                <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md" style={{ background: card.bg, color: card.color }}>
                  Filtered
                </span>
              )}
            </div>
            {loading ? (
              <div className="h-8 w-14 shimmer" />
            ) : (
              <div className="text-[22px] font-bold tracking-tight" style={{ color: card.color }}>
                {values[card.key]}
              </div>
            )}
            <div className="text-[11px] font-medium mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {card.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
