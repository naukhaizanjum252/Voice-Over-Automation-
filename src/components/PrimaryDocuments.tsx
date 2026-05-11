'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { PrimaryDocument } from '@/types';

const AVAILABLE_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', desc: 'Fastest, lowest cost' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', desc: 'Balanced speed & quality' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', desc: 'Highest quality' },
];

export default function PrimaryDocuments() {
  const [docs, setDocs] = useState<PrimaryDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scriptModel, setScriptModel] = useState('claude-haiku-4-5-20251001');
  const [modelSaving, setModelSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch('/api/primary-documents');
      if (res.ok) {
        const data = await res.json();
        setDocs(data);
      }
    } catch (err) {
      console.error('Failed to fetch primary documents:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch current model setting
  useEffect(() => {
    fetch('/api/settings?key=script_model')
      .then((r) => r.json())
      .then((d) => { if (d.value) setScriptModel(d.value); })
      .catch(console.error);
  }, []);

  const handleModelChange = async (newModel: string) => {
    setScriptModel(newModel);
    setModelSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'script_model', value: newModel }),
      });
    } catch {
      console.error('Failed to save model setting');
    } finally {
      setModelSaving(false);
    }
  };

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);

    for (const file of Array.from(files)) {
      try {
        const formData = new FormData();
        formData.append('file', file);

        const res = await fetch('/api/primary-documents', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json();
          alert(`Failed to upload "${file.name}": ${err.error}`);
          continue;
        }

        const doc: PrimaryDocument = await res.json();
        setDocs((prev) => [...prev, doc]);
      } catch {
        alert(`Failed to upload "${file.name}"`);
      }
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemove = async (id: string) => {
    try {
      const res = await fetch('/api/primary-documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        setDocs((prev) => prev.filter((d) => d.id !== id));
      } else {
        alert('Failed to remove document');
      }
    } catch {
      alert('Failed to remove document');
    }
  };

  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{ background: 'var(--surface)', borderColor: 'var(--border-light)', boxShadow: 'var(--shadow-sm)' }}
    >
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-5 py-4 flex items-center justify-between t"
        style={{ background: 'var(--surface)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--accent-muted)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--accent-dark)' }}>
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <div className="text-left">
            <p className="text-[13px] font-bold" style={{ color: 'var(--text)' }}>
              Primary Instruction Documents
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {loading ? 'Loading...' : `${docs.length} document${docs.length !== 1 ? 's' : ''}`}
              {' — shared across all channels'}
            </p>
          </div>
        </div>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="t shrink-0" style={{ color: 'var(--text-muted)', transform: expanded ? 'rotate(180deg)' : '' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Model selector — always visible */}
      <div
        className="px-5 py-3 border-t flex items-center justify-between gap-3"
        style={{ borderColor: 'var(--border-light)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: '#fef3c7' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#d97706' }}>
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <p className="text-[12px] font-bold" style={{ color: 'var(--text)' }}>
              Script Model
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {modelSaving && (
            <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: 'var(--text-muted)' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
          <select
            value={scriptModel}
            onChange={(e) => handleModelChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{
              height: 32,
              padding: '0 10px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {AVAILABLE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.desc}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-5 pb-5 border-t" style={{ borderColor: 'var(--border-light)' }}>
          <div className="pt-4">
            {/* Document list */}
            {docs.length > 0 && (
              <div className="space-y-2 mb-4">
                {docs.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--accent)', flexShrink: 0 }}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="text-[12px] font-medium truncate" style={{ color: 'var(--text)' }}>
                        {doc.name}
                      </span>
                      <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                        {(doc.size / 1024).toFixed(0)} KB
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemove(doc.id)}
                      className="p-1.5 rounded-md t shrink-0 ml-2"
                      style={{ color: 'var(--text-muted)' }}
                      title="Remove"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Upload area with drag & drop */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.doc,.docx,.pdf,.md"
              multiple
              onChange={(e) => handleUpload(e.target.files)}
              className="hidden"
            />
            <div
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); dragCounter.current++; setDragging(true); }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); dragCounter.current--; if (dragCounter.current === 0) setDragging(false); }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dragCounter.current = 0; setDragging(false); handleUpload(e.dataTransfer.files); }}
              onClick={() => !uploading && fileInputRef.current?.click()}
              className="w-full py-3.5 rounded-xl border-2 border-dashed t flex items-center justify-center gap-2 text-[12px] font-semibold"
              style={{
                borderColor: dragging ? 'var(--accent)' : 'var(--border)',
                color: uploading ? 'var(--text-muted)' : 'var(--accent-dark)',
                background: dragging ? 'var(--accent-muted)' : 'transparent',
                cursor: uploading ? 'wait' : 'pointer',
              }}
            >
              {uploading ? (
                <>
                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                  Uploading...
                </>
              ) : dragging ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Drop files here
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Drop files or click to upload (.md, .txt, .docx, .pdf)
                </>
              )}
            </div>

            <p className="text-[10px] mt-2.5 text-center" style={{ color: 'var(--text-muted)' }}>
              These documents form the core instructions for AI script generation. They are used as system context for every script generated across all channels.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
