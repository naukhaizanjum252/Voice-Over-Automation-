'use client';

import { useState, useEffect, useRef } from 'react';
import type { TrelloBoard, TrelloList, Voice } from '@/types';

interface Props {
  onCreated: () => void;
  onCancel: () => void;
}

export default function ChannelForm({ onCreated, onCancel }: Props) {
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);

  const [name, setName] = useState('');
  const [boards, setBoards] = useState<TrelloBoard[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(true);
  const [selectedBoard, setSelectedBoard] = useState('');
  const [boardSearch, setBoardSearch] = useState('');
  const [boardDropdownOpen, setBoardDropdownOpen] = useState(false);

  const [lists, setLists] = useState<TrelloList[]>([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [selectedLists, setSelectedLists] = useState<string[]>([]);
  const [listSearch, setListSearch] = useState('');

  const [autoRun, setAutoRun] = useState(true);

  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [voicesError, setVoicesError] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [voiceSearch, setVoiceSearch] = useState('');
  const [speed, setSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(1.0);
  const [stability, setStability] = useState(0.5);

  const boardDropdownRef = useRef<HTMLDivElement>(null);

  // Close board dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boardDropdownRef.current && !boardDropdownRef.current.contains(e.target as Node)) {
        setBoardDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fetch boards
  useEffect(() => {
    fetch('/api/trello/boards')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setBoards(d); })
      .catch(console.error)
      .finally(() => setBoardsLoading(false));
  }, []);

  // Fetch voices
  useEffect(() => {
    fetch('/api/voices')
      .then(async (r) => {
        if (!r.ok) {
          const err = await r.json();
          setVoicesError(err.error || 'Failed to load voices');
          return;
        }
        return r.json();
      })
      .then((d) => {
        if (Array.isArray(d)) {
          setVoices(d);
          if (d.length > 0 && !voiceId) setVoiceId(d[0].voice_id);
        }
      })
      .catch((err) => setVoicesError(err.message))
      .finally(() => setVoicesLoading(false));
  }, []);

  // Fetch lists when board changes
  useEffect(() => {
    if (!selectedBoard) { setLists([]); setSelectedLists([]); return; }
    setListsLoading(true);
    fetch(`/api/trello/lists?boardId=${encodeURIComponent(selectedBoard)}`)
      .then(async (r) => {
        if (!r.ok) {
          const err = await r.json();
          console.error('Lists error:', err);
          return [];
        }
        return r.json();
      })
      .then((d) => { if (Array.isArray(d)) setLists(d); setSelectedLists([]); })
      .catch(console.error)
      .finally(() => setListsLoading(false));
  }, [selectedBoard]);

  const toggleList = (id: string) =>
    setSelectedLists((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const canStep1 = name.trim() && selectedBoard && selectedLists.length > 0;
  const canSubmit = canStep1 && voiceId;

  const selectedBoardObj = boards.find((b) => b.id === selectedBoard);

  const filteredBoards = boards.filter((b) => {
    if (!boardSearch) return true;
    return b.name.toLowerCase().includes(boardSearch.toLowerCase());
  });

  const filteredLists = lists.filter((l) => {
    if (!listSearch) return true;
    return l.name.toLowerCase().includes(listSearch.toLowerCase());
  });

  const filteredVoices = voices.filter((v) => {
    if (!voiceSearch) return true;
    const q = voiceSearch.toLowerCase();
    const lbls = v.labels ? Object.values(v.labels).join(' ').toLowerCase() : '';
    return v.name.toLowerCase().includes(q) || v.voice_id.toLowerCase().includes(q) || v.category.toLowerCase().includes(q) || lbls.includes(q);
  });

  const selectedVoice = voices.find((v) => v.voice_id === voiceId);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await fetch('/api/channel/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          trello_board_id: selectedBoard,
          trello_list_ids: selectedLists,
          auto_run_enabled: autoRun,
          voice_config: { voiceId, speed, pitch, stability },
        }),
      });
      if (res.ok) onCreated();
      else { const e = await res.json(); alert(`Error: ${e.error}`); }
    } catch { alert('Failed to create channel'); }
    finally { setSaving(false); }
  };

  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{ background: 'var(--surface)', borderColor: 'var(--border-light)', boxShadow: 'var(--shadow-lg)' }}
    >
      {/* Header */}
      <div
        className="px-6 py-4 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border-light)', background: 'var(--surface)' }}
      >
        <div className="flex items-center gap-5">
          <h2 className="text-[15px] font-bold" style={{ color: 'var(--text)' }}>New Channel</h2>
          <div className="flex items-center gap-1.5">
            <StepPill n={1} active={step === 1} done={step > 1} label="Trello" onClick={() => setStep(1)} />
            <div className="w-5 h-px" style={{ background: 'var(--border)' }} />
            <StepPill n={2} active={step === 2} done={false} label="Voice" onClick={() => canStep1 && setStep(2)} />
          </div>
        </div>
        <button onClick={onCancel} className="p-1.5 rounded-lg t" style={{ color: 'var(--text-muted)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="p-6">
        {step === 1 ? (
          <div className="grid gap-5 fade-up">
            {/* Channel Name */}
            <Field label="Channel Name">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Tech News Hindi"
                style={inputStyle}
              />
            </Field>

            {/* Board — searchable dropdown */}
            <Field label="Trello Board">
              {boardsLoading ? <div className="h-10 shimmer" /> : (
                <div className="relative" ref={boardDropdownRef}>
                  {/* Trigger */}
                  <button
                    type="button"
                    onClick={() => setBoardDropdownOpen(!boardDropdownOpen)}
                    className="w-full text-left flex items-center justify-between t"
                    style={{
                      ...inputStyle,
                      display: 'flex',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: selectedBoardObj ? 'var(--text)' : 'var(--text-muted)',
                    }}
                  >
                    <span className="truncate">{selectedBoardObj?.name || 'Select a board...'}</span>
                    <svg
                      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      className="shrink-0 t" style={{ transform: boardDropdownOpen ? 'rotate(180deg)' : '' }}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>

                  {/* Dropdown */}
                  {boardDropdownOpen && (
                    <div
                      className="absolute left-0 right-0 top-full mt-1 rounded-xl border overflow-hidden z-20"
                      style={{ background: 'var(--surface)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-lg)' }}
                    >
                      {/* Search */}
                      <div className="p-2 border-b" style={{ borderColor: 'var(--border-light)' }}>
                        <div className="relative">
                          <SearchIcon />
                          <input
                            type="text"
                            value={boardSearch}
                            onChange={(e) => setBoardSearch(e.target.value)}
                            placeholder="Search boards..."
                            autoFocus
                            className="w-full"
                            style={{ ...inputStyle, height: '34px', paddingLeft: '34px', fontSize: '12px' }}
                          />
                        </div>
                      </div>
                      {/* Options */}
                      <div className="max-h-48 overflow-y-auto">
                        {filteredBoards.length === 0 ? (
                          <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>
                            No boards found
                          </p>
                        ) : filteredBoards.map((b) => {
                          const on = selectedBoard === b.id;
                          return (
                            <button
                              key={b.id}
                              onClick={() => {
                                setSelectedBoard(b.id);
                                setBoardDropdownOpen(false);
                                setBoardSearch('');
                              }}
                              className="w-full text-left px-3 py-2.5 text-[13px] t flex items-center justify-between"
                              style={{
                                background: on ? 'var(--accent-muted)' : 'var(--surface)',
                                color: on ? 'var(--accent-dark)' : 'var(--text)',
                              }}
                            >
                              <span className="truncate font-medium">{b.name}</span>
                              {on && <CheckIcon />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Field>

            {/* Lists — searchable multi-select */}
            {selectedBoard && (
              <Field label="Lists to Monitor">
                {listsLoading ? <div className="h-16 shimmer" /> : lists.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No lists found in this board.</p>
                ) : (
                  <div>
                    {/* Search (only show if > 5 lists) */}
                    {lists.length > 5 && (
                      <div className="relative mb-2">
                        <SearchIcon />
                        <input
                          type="text"
                          value={listSearch}
                          onChange={(e) => setListSearch(e.target.value)}
                          placeholder="Search lists..."
                          className="w-full"
                          style={{ ...inputStyle, height: '34px', paddingLeft: '34px', fontSize: '12px' }}
                        />
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {filteredLists.map((l) => {
                        const on = selectedLists.includes(l.id);
                        return (
                          <button
                            key={l.id}
                            onClick={() => toggleList(l.id)}
                            className="h-8 px-3.5 rounded-lg text-xs font-semibold t border flex items-center gap-1.5"
                            style={{
                              background: on ? 'var(--accent)' : 'var(--surface)',
                              borderColor: on ? 'var(--accent)' : 'var(--border)',
                              color: on ? '#fff' : 'var(--text-secondary)',
                              boxShadow: on ? 'var(--shadow-accent)' : 'none',
                            }}
                          >
                            {on && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                            )}
                            {l.name}
                          </button>
                        );
                      })}
                      {filteredLists.length === 0 && listSearch && (
                        <p className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>No lists match "{listSearch}"</p>
                      )}
                    </div>
                    {selectedLists.length > 0 && (
                      <p className="text-[11px] mt-2 font-medium" style={{ color: 'var(--accent)' }}>
                        {selectedLists.length} list{selectedLists.length !== 1 ? 's' : ''} selected
                      </p>
                    )}
                  </div>
                )}
              </Field>
            )}

            {/* Auto-run */}
            <div
              className="flex items-center justify-between p-4 rounded-xl border"
              style={{ borderColor: 'var(--border-light)', background: 'var(--surface)' }}
            >
              <div>
                <p className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>Auto Processing</p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Automatically process new cards every 10 minutes
                </p>
              </div>
              <Toggle on={autoRun} onChange={setAutoRun} />
            </div>

            <div className="flex justify-end pt-1">
              <button
                onClick={() => setStep(2)}
                disabled={!canStep1}
                className="h-10 px-5 rounded-xl text-[13px] font-semibold t flex items-center gap-2 disabled:opacity-30"
                style={{ background: 'var(--accent)', color: '#fff', boxShadow: 'var(--shadow-accent)' }}
              >
                Continue
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              </button>
            </div>
          </div>
        ) : (
          /* ── Step 2: Voice ── */
          <div className="grid gap-5 fade-up">
            <Field label="Select Voice">
              {voicesLoading ? <div className="h-10 shimmer" /> : voicesError ? (
                <div className="rounded-xl border p-4" style={{ borderColor: 'var(--danger)', background: 'var(--danger-muted)' }}>
                  <p className="text-[12px] font-semibold" style={{ color: 'var(--danger)' }}>Failed to load voices</p>
                  <p className="text-[11px] mt-1 font-mono" style={{ color: 'var(--danger)' }}>{voicesError}</p>
                  <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
                    You can manually enter a voice ID below, or hit <code>/api/debug</code> in your browser to diagnose the API connection.
                  </p>
                  <input
                    type="text"
                    value={voiceId}
                    onChange={(e) => setVoiceId(e.target.value)}
                    placeholder="Enter voice ID manually..."
                    className="mt-3 w-full"
                    style={inputStyle}
                  />
                </div>
              ) : (
                <>
                  {/* Voice search */}
                  <div className="relative mb-2">
                    <SearchIcon />
                    <input
                      type="text"
                      value={voiceSearch}
                      onChange={(e) => setVoiceSearch(e.target.value)}
                      placeholder="Search by name, accent, gender..."
                      className="w-full"
                      style={{ ...inputStyle, paddingLeft: '36px' }}
                    />
                  </div>

                  {/* Voice list */}
                  <div
                    className="max-h-52 overflow-y-auto rounded-xl border divide-y"
                    style={{ borderColor: 'var(--border-light)', background: 'var(--surface)' }}
                  >
                    {filteredVoices.length === 0 ? (
                      <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No voices match your search</p>
                    ) : filteredVoices.map((v) => {
                      const on = voiceId === v.voice_id;
                      const gender = v.labels?.gender;
                      const accent = v.labels?.accent;
                      const useCase = v.labels?.use_case;
                      return (
                        <button
                          key={v.voice_id}
                          onClick={() => setVoiceId(v.voice_id)}
                          className="w-full text-left px-4 py-3 t flex items-center justify-between group"
                          style={{
                            background: on ? 'var(--accent-muted)' : 'var(--surface)',
                            borderColor: 'var(--border-light)',
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="text-[13px] font-semibold truncate" style={{ color: on ? 'var(--accent-dark)' : 'var(--text)' }}>
                                {v.name}
                              </p>
                              <span
                                className="text-[10px] font-medium px-1.5 py-0.5 rounded-md shrink-0"
                                style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                              >
                                {v.category}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              {gender && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{gender}</span>}
                              {accent && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{accent}</span>}
                              {useCase && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                                  {useCase}
                                </span>
                              )}
                            </div>
                          </div>
                          {on && (
                            <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 ml-3" style={{ background: 'var(--accent)' }}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {selectedVoice && (
                    <div
                      className="mt-2 inline-flex items-center gap-2 text-[11px] font-semibold px-3 py-1.5 rounded-lg"
                      style={{ background: 'var(--accent-muted)', color: 'var(--accent-dark)' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                      </svg>
                      {selectedVoice.name}
                      <span style={{ color: 'var(--text-muted)' }}>({selectedVoice.voice_id.slice(0, 10)}...)</span>
                    </div>
                  )}
                </>
              )}
            </Field>

            {/* Sliders */}
            <div
              className="grid grid-cols-1 sm:grid-cols-3 gap-5 p-5 rounded-xl border"
              style={{ borderColor: 'var(--border-light)', background: 'var(--surface)' }}
            >
              <Slider label="Speed" value={speed} onChange={setSpeed} min={0.5} max={2.0} step={0.1} unit="x" />
              <Slider label="Pitch" value={pitch} onChange={setPitch} min={0.5} max={2.0} step={0.1} unit="x" />
              <Slider label="Stability" value={stability} onChange={setStability} min={0} max={1} step={0.05} unit="" />
            </div>

            {/* Actions */}
            <div className="flex justify-between pt-1">
              <button
                onClick={() => setStep(1)}
                className="h-10 px-4 rounded-xl text-[13px] font-semibold t flex items-center gap-2"
                style={{ color: 'var(--text-secondary)', background: 'var(--surface-2)' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                Back
              </button>
              <button
                onClick={handleSubmit}
                disabled={saving || !canSubmit}
                className="h-10 px-6 rounded-xl text-[13px] font-bold t flex items-center gap-2 disabled:opacity-30"
                style={{ background: 'var(--accent)', color: '#fff', boxShadow: 'var(--shadow-accent)' }}
              >
                {saving ? (
                  <>
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    Creating...
                  </>
                ) : (
                  <>
                    Create Channel
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Shared sub-components ── */

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: '40px',
  padding: '0 12px',
  borderRadius: '10px',
  fontSize: '13px',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  outline: 'none',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold mb-2 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="relative w-11 h-6 rounded-full t shrink-0"
      style={{ background: on ? 'var(--accent)' : 'var(--surface-3)' }}
    >
      <span
        className="absolute top-1 w-4 h-4 rounded-full t"
        style={{ left: on ? '24px' : '4px', background: '#fff', boxShadow: 'var(--shadow-sm)' }}
      />
    </button>
  );
}

function StepPill({ n, active, done, label, onClick }: { n: number; active: boolean; done: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 t">
      <span
        className="w-6 h-6 rounded-full text-[11px] font-bold flex items-center justify-center t"
        style={{
          background: active ? 'var(--accent)' : done ? 'var(--success)' : 'var(--surface-2)',
          color: active || done ? '#fff' : 'var(--text-muted)',
          boxShadow: active ? 'var(--shadow-accent)' : 'none',
        }}
      >
        {done ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
        ) : n}
      </span>
      <span className="text-[11px] font-semibold hidden sm:inline" style={{ color: active ? 'var(--accent-dark)' : 'var(--text-muted)' }}>
        {label}
      </span>
    </button>
  );
}

function Slider({ label, value, onChange, min, max, step, unit }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; unit: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <label className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</label>
        <span className="text-[11px] font-bold px-2 py-0.5 rounded-md" style={{ background: 'var(--accent-muted)', color: 'var(--accent-dark)' }}>
          {value.toFixed(step < 0.1 ? 2 : 1)}{unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full" />
    </div>
  );
}

function SearchIcon() {
  return (
    <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--accent)' }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
    </div>
  );
}
