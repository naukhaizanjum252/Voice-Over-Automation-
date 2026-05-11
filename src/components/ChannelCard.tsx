'use client';

import { useState } from 'react';
import type { Channel, ChannelStats, ProcessedCard, ProcessingStage, TitleListMappingResolved } from '@/types';
import { ELEVENLABS_VOICES } from '@/data/elevenlabs-voices';

interface Props {
  stats: ChannelStats;
  onRefresh: () => void;
  onEdit?: (channelId: string) => void;
}

const STAGES: { key: ProcessingStage; label: string }[] = [
  { key: 'script_generating', label: 'Reading Title' },
  { key: 'downloading', label: 'Generating Script' },
  { key: 'extracting', label: 'Queued for Voice' },
  { key: 'queued', label: 'Generating Voice' },
  { key: 'generating', label: 'Uploading' },
];

export default function ChannelCard({ stats, onRefresh, onEdit }: Props) {
  const { channel, total, completed, failed, processing, lastRun, cards } = stats;
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [retryingAll, setRetryingAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const failedCards = cards.filter((c) => c.status === 'failed');
  const processingCards = cards.filter((c) => c.status === 'processing' || c.status === 'pending');

  const handleRun = async () => {
    setRunning(true);
    try {
      await fetch(`/api/channel/run?channelId=${channel.id}`, { method: 'POST' });
      onRefresh();
    } catch (err) { console.error('Run failed:', err); }
    finally { setRunning(false); }
  };

  const handleRetryAll = async () => {
    setRetryingAll(true);
    try {
      for (const card of failedCards) {
        await fetch('/api/card/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardId: card.id }),
        });
      }
      onRefresh();
    } catch (err) { console.error('Retry all failed:', err); }
    finally { setRetryingAll(false); }
  };

  const ago = (iso: string | null) => {
    if (!iso) return 'Never';
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
  };

  return (
    <div
      className="rounded-2xl border overflow-hidden t"
      style={{
        background: 'var(--surface)',
        borderColor: expanded ? 'var(--border)' : 'var(--border-light)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {/* Main */}
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          {/* Left */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-[15px] font-bold truncate" style={{ color: 'var(--text)' }}>{channel.name}</h3>
              {channel.auto_run_enabled ? (
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 uppercase tracking-wide"
                  style={{ background: 'var(--success-muted)', color: 'var(--success)' }}
                >
                  <span className="w-1.5 h-1.5 rounded-full pulse" style={{ background: 'var(--success-light)' }} />
                  Auto
                </span>
              ) : (
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                >
                  Manual
                </span>
              )}
            </div>

            <div className="flex items-center gap-3.5 mt-2 flex-wrap">
              <InfoChip icon={<BoardIcon />} text={stats.boardName} />
              <InfoChip icon={<ListIcon />} text={stats.listNames.join(', ')} />
              {stats.titleListMappings?.length > 0 && (
                <InfoChip icon={<PenIcon />} text={`Titles: ${stats.titleListMappings?.map((m) => m.titleListName).join(', ')}`} />
              )}
              <InfoChip icon={<ClockIcon />} text={ago(lastRun)} />
              {total > 0 && <InfoChip icon={<CheckCircleIcon />} text={`${successRate}% success`} />}
            </div>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleRun}
              disabled={running}
              className="h-9 px-3.5 rounded-xl text-[12px] font-bold t flex items-center gap-1.5 disabled:opacity-40"
              style={{
                background: running ? 'var(--accent-muted)' : 'var(--accent)',
                color: running ? 'var(--accent)' : '#fff',
                boxShadow: running ? 'none' : 'var(--shadow-accent)',
              }}
            >
              {running ? (
                <><Spinner /> Running...</>
              ) : (
                <>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                  Run Now
                </>
              )}
            </button>
            {failed > 0 && (
              <button
                onClick={handleRetryAll}
                disabled={retryingAll}
                className="h-9 px-3.5 rounded-xl text-[12px] font-bold t flex items-center gap-1.5 disabled:opacity-40 border"
                style={{
                  borderColor: 'var(--danger)',
                  color: 'var(--danger)',
                  background: retryingAll ? 'var(--danger-muted)' : 'transparent',
                }}
              >
                {retryingAll ? <><Spinner /> Retrying...</> : (
                  <><RefreshIcon size={11} /> Retry All</>
                )}
              </button>
            )}
            <button
              onClick={() => onEdit?.(channel.id)}
              className="h-9 w-9 rounded-xl t flex items-center justify-center"
              style={{ color: 'var(--text-muted)' }}
              title="Edit channel"
            >
              <EditIcon size={14} />
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="h-9 w-9 rounded-xl t flex items-center justify-center"
              style={{ color: 'var(--text-muted)' }}
              title="Delete channel"
            >
              <TrashIcon size={14} />
            </button>
          </div>
        </div>

        {/* Delete confirmation */}
        {confirmDelete && (
          <div
            className="mt-4 rounded-xl p-3.5 flex items-center justify-between gap-3 fade-up"
            style={{ background: 'var(--danger-muted)', border: '1px solid var(--danger)' }}
          >
            <p className="text-[12px] font-semibold" style={{ color: 'var(--danger)' }}>
              Delete &quot;{channel.name}&quot; and all its processed cards?
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setConfirmDelete(false)}
                className="h-8 px-3 rounded-lg text-[11px] font-bold"
                style={{ color: 'var(--text-muted)' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await fetch(`/api/channel/delete?channelId=${channel.id}`, { method: 'DELETE' });
                    onRefresh();
                  } catch (err) { console.error('Delete failed:', err); }
                  finally { setDeleting(false); setConfirmDelete(false); }
                }}
                disabled={deleting}
                className="h-8 px-3.5 rounded-lg text-[11px] font-bold t flex items-center gap-1.5 disabled:opacity-40"
                style={{ background: 'var(--danger)', color: '#fff' }}
              >
                {deleting ? <><Spinner /> Deleting...</> : 'Yes, delete'}
              </button>
            </div>
          </div>
        )}

        {/* Processing cards — stage stepper */}
        {processingCards.length > 0 && (
          <div className="mt-4 space-y-3">
            {processingCards.map((card) => (
              <StageStepper key={card.id} card={card} onRefresh={onRefresh} />
            ))}
          </div>
        )}

        {/* Config preview cards */}
        <ConfigPreview channel={channel} titleListMappings={stats.titleListMappings} listNames={stats.listNames} boardName={stats.boardName} />

        {/* Stats row */}
        <div className="mt-5 grid grid-cols-4 gap-2.5">
          <Pill label="Total" value={total} />
          <Pill label="Done" value={completed} color="var(--success)" bg="var(--success-muted)" />
          <Pill label="Failed" value={failed} color="var(--danger)" bg="var(--danger-muted)" />
          <Pill label="Active" value={processing} color="var(--warning)" bg="var(--warning-muted)" pulse={processing > 0} />
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="mt-4 h-[5px] rounded-full overflow-hidden" style={{ background: 'var(--surface-3)' }}>
            <div className="h-full flex">
              {completed > 0 && (
                <div className="h-full t" style={{ width: `${(completed / total) * 100}%`, background: 'var(--success-light)', borderRadius: failed + processing === 0 ? '99px' : '99px 0 0 99px' }} />
              )}
              {processing > 0 && (
                <div className="h-full t" style={{ width: `${(processing / total) * 100}%`, background: 'var(--warning)' }} />
              )}
              {failed > 0 && (
                <div className="h-full t" style={{ width: `${(failed / total) * 100}%`, background: 'var(--danger-light)', borderRadius: completed + processing === 0 ? '99px' : '0 99px 99px 0' }} />
              )}
            </div>
          </div>
        )}

        {/* Expand toggle */}
        {total > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-4 text-[11px] font-bold t flex items-center gap-1.5"
            style={{ color: 'var(--accent)' }}
          >
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className="t"
              style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
            {expanded ? 'Hide' : 'Show'} {total} card{total !== 1 ? 's' : ''}
          </button>
        )}
      </div>

      {/* All processed cards */}
      {expanded && cards.length > 0 && (
        <div className="border-t" style={{ borderColor: 'var(--border-light)', background: 'var(--bg)' }}>
          <div
            className="px-5 py-2.5 border-b flex items-center gap-2"
            style={{ borderColor: 'var(--border-light)' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="21" x2="9" y2="9" />
            </svg>
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Processed Cards
            </span>
          </div>
          {cards.map((card, i) => (
            <CardRow key={card.id} card={card} onRefresh={onRefresh} last={i === cards.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ── */

function StageStepper({ card, onRefresh }: { card: ProcessedCard; onRefresh: () => void }) {
  const [terminating, setTerminating] = useState(false);
  const isPending = card.status === 'pending';
  const currentStage = card.processing_stage;
  // For pending cards (script done, awaiting voiceover): Reading Title + Generating Script done,
  // paused at "Queued for Voice" (index 2)
  const currentIdx = isPending
    ? 2
    : currentStage ? STAGES.findIndex((s) => s.key === currentStage) : -1;

  const handleTerminate = async () => {
    setTerminating(true);
    try {
      await fetch('/api/card/terminate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id }),
      });
      onRefresh();
    } catch (err) { console.error(err); }
    finally { setTerminating(false); }
  };

  const borderColor = isPending ? 'var(--accent)' : 'var(--warning)';
  const bgColor = isPending ? 'var(--accent-muted)' : 'var(--warning-muted)';

  return (
    <div className="rounded-xl p-3.5" style={{ background: bgColor, border: `1px solid ${borderColor}` }}>
      <div className="flex items-center justify-between mb-2.5">
        <p className="text-[12px] font-semibold truncate" style={{ color: 'var(--text)' }}>
          {card.card_name || card.trello_card_id}
        </p>
        {isPending ? (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0" style={{ background: 'var(--accent-muted)', color: 'var(--accent-dark)', border: '1px solid var(--accent)' }}>
            Queued for Voice
          </span>
        ) : (
          <button
            onClick={handleTerminate}
            disabled={terminating}
            className="h-6 px-2 rounded-md text-[10px] font-bold shrink-0 t flex items-center gap-1 disabled:opacity-40"
            style={{ background: 'var(--danger-muted)', color: 'var(--danger)', border: '1px solid var(--danger)' }}
            title="Terminate this process"
          >
            {terminating ? <Spinner /> : <StopIcon size={9} />}
            Stop
          </button>
        )}
      </div>
      <div className="flex items-center gap-1">
        {STAGES.map((stage, idx) => {
          const isDone = idx < currentIdx;
          const isActive = idx === currentIdx;
          const isPending = idx > currentIdx;

          return (
            <div key={stage.key} className="flex items-center gap-1 flex-1 min-w-0">
              {/* Step dot/icon */}
              <div className="flex flex-col items-center gap-1 flex-1">
                <div className="flex items-center w-full">
                  {/* Connector line before */}
                  {idx > 0 && (
                    <div
                      className="h-[2px] flex-1 rounded t"
                      style={{ background: isDone || isActive ? (isPending ? 'var(--accent)' : 'var(--warning)') : 'var(--border-light)' }}
                    />
                  )}
                  {/* Dot */}
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${isActive && !isPending ? 'pulse' : ''}`}
                    style={{
                      background: isDone ? 'var(--success)' : isActive ? (isPending ? 'var(--accent)' : 'var(--warning)') : 'var(--surface-3)',
                      border: isActive ? `2px solid ${isPending ? 'var(--accent)' : 'var(--warning)'}` : 'none',
                    }}
                  >
                    {isDone ? (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : isActive && isPending ? (
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="#fff">
                        <rect x="5" y="4" width="5" height="16" rx="1" />
                        <rect x="14" y="4" width="5" height="16" rx="1" />
                      </svg>
                    ) : isActive ? (
                      <Spinner />
                    ) : (
                      <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--text-muted)' }} />
                    )}
                  </div>
                  {/* Connector line after */}
                  {idx < STAGES.length - 1 && (
                    <div
                      className="h-[2px] flex-1 rounded t"
                      style={{ background: isDone ? 'var(--success)' : 'var(--border-light)' }}
                    />
                  )}
                </div>
                <span
                  className="text-[9px] font-bold uppercase tracking-wide"
                  style={{
                    color: isDone ? 'var(--success)' : isActive ? 'var(--warning)' : 'var(--text-muted)',
                    opacity: isPending ? 0.5 : 1,
                  }}
                >
                  {stage.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CardRow({ card, onRefresh, last }: { card: ProcessedCard; onRefresh: () => void; last: boolean }) {
  const [retrying, setRetrying] = useState(false);
  const [manualAction, setManualAction] = useState<'full' | 'voiceover' | null>(null);

  const retry = async () => {
    setRetrying(true);
    try {
      await fetch('/api/card/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id }),
      });
      onRefresh();
    } catch (err) { console.error(err); }
    finally { setRetrying(false); }
  };

  const manualRun = async (action: 'full' | 'voiceover') => {
    setManualAction(action);
    try {
      await fetch('/api/card/manual-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id, action }),
      });
      onRefresh();
    } catch (err) { console.error(err); }
    finally { setManualAction(null); }
  };

  const statusColor = card.status === 'completed' ? 'var(--success)'
    : card.status === 'failed' ? 'var(--danger)'
    : card.status === 'processing' ? 'var(--warning)'
    : 'var(--text-muted)';

  const statusBg = card.status === 'completed' ? 'var(--success-muted)'
    : card.status === 'failed' ? 'var(--danger-muted)'
    : card.status === 'processing' ? 'var(--warning-muted)'
    : 'var(--surface-2)';

  const statusLabel = card.status === 'processing' && card.processing_stage
    ? card.processing_stage
    : card.status;

  const ago = (() => {
    const ms = Date.now() - new Date(card.updated_at).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(card.updated_at).toLocaleDateString();
  })();

  return (
    <div
      className="px-5 py-3.5"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-light)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--text)' }}>
            {card.card_name || card.trello_card_id}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>{ago}</span>
          <span
            className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide"
            style={{ background: statusBg, color: statusColor }}
          >
            {statusLabel}
          </span>
          {card.status === 'failed' && (
            <button
              onClick={retry}
              disabled={retrying}
              className="h-7 px-2.5 rounded-lg text-[10px] font-bold shrink-0 t flex items-center gap-1 disabled:opacity-40"
              style={{ background: 'var(--danger-muted)', color: 'var(--danger)' }}
            >
              {retrying ? <Spinner /> : <RefreshIcon size={10} />}
              Retry
            </button>
          )}
          {card.status === 'completed' && card.script_url && (
            <a
              href={card.script_url}
              target="_blank"
              rel="noopener noreferrer"
              className="h-7 px-2.5 rounded-lg text-[10px] font-bold flex items-center gap-1"
              style={{ background: 'var(--accent-muted)', color: 'var(--accent-dark)' }}
            >
              <ScriptIcon size={10} />
              Script
            </a>
          )}
          {card.status === 'completed' && card.attachment_url && (
            <a
              href={card.attachment_url}
              target="_blank"
              rel="noopener noreferrer"
              className="h-7 px-2.5 rounded-lg text-[10px] font-bold flex items-center gap-1"
              style={{ background: 'var(--success-muted)', color: 'var(--success)' }}
            >
              <DownloadIcon size={10} />
              Audio
            </a>
          )}
          {/* Manual triggers — available for all non-processing cards */}
          {card.status !== 'processing' && (
            <>
              <button
                onClick={() => manualRun('voiceover')}
                disabled={manualAction !== null}
                className="h-7 px-2.5 rounded-lg text-[10px] font-bold shrink-0 t flex items-center gap-1 disabled:opacity-40 border"
                style={{ borderColor: 'var(--accent)', color: 'var(--accent)', background: manualAction === 'voiceover' ? 'var(--accent-muted)' : 'transparent' }}
                title="Re-generate voiceover only"
              >
                {manualAction === 'voiceover' ? <Spinner /> : <VoiceIcon size={10} />}
                Voice
              </button>
              <button
                onClick={() => manualRun('full')}
                disabled={manualAction !== null}
                className="h-7 px-2.5 rounded-lg text-[10px] font-bold shrink-0 t flex items-center gap-1 disabled:opacity-40 border"
                style={{ borderColor: 'var(--text-muted)', color: 'var(--text-muted)', background: manualAction === 'full' ? 'var(--surface-2)' : 'transparent' }}
                title="Re-run full pipeline (download, extract, generate, upload)"
              >
                {manualAction === 'full' ? <Spinner /> : <RefreshIcon size={10} />}
                Full
              </button>
            </>
          )}
        </div>
      </div>
      {card.status === 'failed' && card.error_message && (
        <p
          className="text-[11px] mt-1.5 font-mono break-words"
          style={{ color: 'var(--danger)', wordBreak: 'break-word', overflowWrap: 'anywhere' }}
        >
          {card.error_message}
        </p>
      )}
      {card.status === 'completed' && card.error_message && (
        <p
          className="text-[11px] mt-1.5 break-words"
          style={{ color: 'var(--text-muted)', wordBreak: 'break-word' }}
        >
          {card.error_message}
        </p>
      )}
    </div>
  );
}

function Pill({ label, value, color, bg, pulse }: {
  label: string; value: number; color?: string; bg?: string; pulse?: boolean;
}) {
  return (
    <div className="rounded-xl p-3 text-center t" style={{ background: bg ?? 'var(--surface-2)' }}>
      <div className={`text-lg font-bold ${pulse ? 'pulse' : ''}`} style={{ color: color ?? 'var(--text)' }}>
        {value}
      </div>
      <div className="text-[10px] font-semibold mt-0.5 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
    </div>
  );
}

function InfoChip({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
      {icon}{text}
    </span>
  );
}

function ConfigPreview({ channel, titleListMappings, listNames, boardName }: { channel: Channel; titleListMappings: TitleListMappingResolved[]; listNames: string[]; boardName: string }) {
  const hasScript = titleListMappings?.length > 0;
  const hasVoice = !!channel.voice_config?.voiceId;

  type CField = { label: string; value: string; pill?: boolean; mono?: boolean };

  const scriptFields: CField[] = [];
  for (const m of (titleListMappings||[])) {
    scriptFields.push({ label: 'Source → Target', value: `${m.titleListName} → ${m.voiceoverListName}`, pill: true });
  }
  if (channel.niche) scriptFields.push({ label: 'Niche', value: channel.niche });
  if (channel.format) scriptFields.push({ label: 'Format', value: channel.format });
  if (channel.length) scriptFields.push({ label: 'Length', value: channel.length });
  if (channel.character_count) scriptFields.push({ label: 'Characters', value: channel.character_count.toLocaleString() });
  if (channel.output) scriptFields.push({ label: 'Output', value: channel.output });
  if (channel.note) scriptFields.push({ label: 'Note', value: channel.note.length > 50 ? channel.note.slice(0, 50) + '...' : channel.note });
  if (channel.feeder_scripts?.length > 0) scriptFields.push({ label: 'Feeder Scripts', value: `${channel.feeder_scripts.length} file${channel.feeder_scripts.length !== 1 ? 's' : ''}` });

  const voiceFields: CField[] = [];
  if (channel.voice_config) {
    const vc = channel.voice_config;
    // Look up voice name from the static catalog
    const voiceEntry = ELEVENLABS_VOICES.find((v) => v.voice_id === vc.voiceId);
    if (voiceEntry) {
      voiceFields.push({ label: 'Voice', value: voiceEntry.name, pill: true });
    }
    voiceFields.push({ label: 'Voice ID', value: vc.voiceId.slice(0, 16) + (vc.voiceId.length > 16 ? '...' : ''), mono: true });
    if (listNames.length > 0) voiceFields.push({ label: 'Source Lists', value: listNames.join(', ') });
    voiceFields.push({ label: 'Speed', value: `${vc.speed.toFixed(1)}x` });
    voiceFields.push({ label: 'Pitch', value: vc.pitch.toFixed(2) });
    voiceFields.push({ label: 'Stability', value: vc.stability.toFixed(2) });
    if (vc.style > 0) voiceFields.push({ label: 'Style', value: vc.style.toFixed(2) });
  }

  if (!hasScript && !hasVoice) return null;

  return (
    <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <ConfigCard
        icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>}
        title="Script Generation"
        fields={scriptFields}
        headerBg="#eef2ff" headerColor="#4f46e5" pillBg="#e0e7ff" pillColor="#3730a3"
      />
      <ConfigCard
        icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /></svg>}
        title="Voice Config"
        fields={voiceFields}
        headerBg="#ecfdf5" headerColor="#047857" pillBg="#d1fae5" pillColor="#065f46"
      />
    </div>
  );
}

function ConfigCard({ icon, title, fields, headerBg, headerColor, pillBg, pillColor }: {
  icon: React.ReactNode; title: string;
  fields: { label: string; value: string; pill?: boolean; mono?: boolean }[];
  headerBg: string; headerColor: string; pillBg: string; pillColor: string;
}) {
  const truncStyle: React.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  };

  return (
    <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-light)', minWidth: 0 }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, background: headerBg }}>
        <span style={{ color: headerColor }}>{icon}</span>
        <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: headerColor }}>
          {title}
        </span>
      </div>
      <div style={{ padding: '12px 14px', background: '#fff', overflow: 'hidden' }}>
        {fields.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {fields.map((f) => (
              <div key={f.label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: '#8b8fa3', flexShrink: 0 }}>
                  {f.label}
                </span>
                {f.pill ? (
                  <span
                    style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                      background: pillBg, color: pillColor, ...truncStyle,
                    }}
                  >
                    {f.value}
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: f.mono ? 10 : 11, fontWeight: 600, textAlign: 'right',
                      color: '#1e1e2e', fontFamily: f.mono ? 'monospace' : 'inherit',
                      ...truncStyle,
                    }}
                  >
                    {f.value}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--text-muted)' }}>Not configured</p>
        )}
      </div>
    </div>
  );
}

/* ── Icons ── */

function BoardIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <rect x="7" y="7" width="3" height="9" /><rect x="14" y="7" width="3" height="5" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function EditIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function TrashIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function ScriptIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}

function DownloadIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function StopIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function VoiceIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function RefreshIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
