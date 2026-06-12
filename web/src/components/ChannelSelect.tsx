import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Plus } from 'lucide-react';

/* Sélecteur de canal maison (remplace le <select> système) :
 * liste rafraîchie à l'ouverture, canal courant coché, création d'un
 * nouveau canal intégrée (il naît côté relais au premier accès). */

function sanitizeChannel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
}

export default function ChannelSelect({
  channel,
  onSelect,
  fetchChannels,
  direction = 'down',
  compact = false,
}: {
  channel: string;
  onSelect: (c: string) => void;
  fetchChannels: () => Promise<string[]>;
  direction?: 'up' | 'down';
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    fetchChannels().then(setList).catch(() => {});
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (c: string) => {
    setOpen(false);
    setCreating(false);
    setDraft('');
    if (c && c !== channel) onSelect(c);
  };

  const items = list.includes(channel) ? list : [channel, ...list];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 bg-slate-950/60 border border-slate-800 rounded-md text-slate-300 outline-none hover:border-slate-600 transition-colors ${
          compact ? 'text-[10px] uppercase tracking-wider px-2 py-1 max-w-[130px]' : 'text-xs h-9 px-2.5 w-full justify-between'
        }`}
      >
        <span className="truncate">{channel}</span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className={`absolute ${direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} ${
            compact ? 'right-0 w-48' : 'left-0 right-0'
          } z-50 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden`}
        >
          <div className="max-h-48 overflow-y-auto">
            {items.map((c) => (
              <button
                key={c}
                onClick={() => pick(c)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-slate-300 hover:bg-slate-800"
              >
                <span className="flex-1 truncate">{c}</span>
                {c === channel && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="border-t border-slate-800">
            {!creating ? (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                <Plus className="w-3.5 h-3.5" /> Nouveau canal…
              </button>
            ) : (
              <form
                className="flex items-center gap-1 p-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = sanitizeChannel(draft);
                  if (name) pick(name);
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="nom-du-canal"
                  className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 outline-none focus:border-blue-500/60"
                />
                <button type="submit" className="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white">
                  OK
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
