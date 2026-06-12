import React from 'react';
import { Card, Badge } from './UI';
import { Review, Lock, Note } from '../types';
import { GitPullRequest, LockKeyhole, Terminal } from 'lucide-react';

interface MiscListsProps {
  reviews: Review[];
  locks: Lock[];
  notes: Note[];
}

export default function MiscLists({ reviews, locks, notes }: MiscListsProps) {
  const rIcon = { pending: 'bg-amber-500', approved: 'bg-emerald-500', changes_requested: 'bg-rose-500', closed: 'bg-slate-600' } as any;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl">
      
      {/* REVIEWS & LOCKS COL */}
      <div className="space-y-8">
        <section>
          <div className="flex items-center gap-2 mb-4 text-slate-400 text-xs font-semibold uppercase tracking-widest px-1">
            <GitPullRequest className="w-4 h-4 text-purple-400" /> Demandes de Revue
          </div>
          <div className="space-y-3">
            {(!reviews || reviews.length === 0) && <div className="text-slate-500 text-sm p-4 border border-dashed border-slate-800 rounded-xl">Aucune revue en attente.</div>}
            {(reviews || []).slice(-6).map(r => (
              <Card key={r.id} className="p-4 bg-slate-900 border-white/5 shadow-sm group">
                <div className="flex items-start gap-4">
                  <div className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${rIcon[r.status] || 'bg-slate-500'}`}></div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-200 text-sm truncate leading-tight mb-1">{r.title}</p>
                    <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                      <span>{r.id}</span>
                      <span className="text-slate-700">|</span>
                      <span className="truncate">{r.from} &rarr; {r.to}</span>
                    </div>
                  </div>
                  <Badge variant="idle" className="text-[10px] capitalize shrink-0">{r.status.replace('_', ' ')}</Badge>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-4 text-slate-400 text-xs font-semibold uppercase tracking-widest px-1">
            <LockKeyhole className="w-4 h-4 text-rose-400" /> Fichiers Verrouillés
          </div>
          <div className="space-y-3">
            {(!locks || locks.length === 0) && <div className="text-slate-500 text-sm p-4 border border-dashed border-slate-800 rounded-xl">Aucun fichier verrouillé.</div>}
            {(locks || []).map((l, i) => (
              <div key={i} className="px-4 py-3 bg-[#0d1117] rounded-xl flex items-center justify-between border border-slate-800/60">
                <div className="font-mono text-xs text-slate-300 truncate mr-4">{l.path}</div>
                <div className="flex items-center gap-2 shrink-0">
                   <span className="text-[10px] uppercase text-slate-500">{l.owner}</span>
                   {l.reason && <span className="w-3 h-3 bg-rose-500/20 text-rose-500 rounded-full flex items-center justify-center cursor-help" title={l.reason}>!</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* SYSTEM LOGS COL */}
      <div className="space-y-8">
        <section className="flex flex-col h-full">
          <div className="flex items-center gap-2 mb-4 text-slate-400 text-xs font-semibold uppercase tracking-widest px-1 shrink-0">
            <Terminal className="w-4 h-4 text-emerald-400" /> Notes Système
          </div>
          <Card className="flex-1 p-0 bg-[#0d1117] border-slate-800/60 overflow-hidden flex flex-col min-h-[300px]">
             <div className="p-4 flex-1 overflow-y-auto space-y-3 custom-scrollbar">
               {(!notes || notes.length === 0) && <div className="text-slate-500 text-sm">Le journal est vide.</div>}
               {(notes || []).map((n, i) => (
                 <div key={i} className="text-sm font-mono border-l-2 border-slate-800 pl-3 py-1">
                   <div className="text-[10px] text-emerald-500/70 mb-0.5">{n.by}</div>
                   <div className="text-slate-400 whitespace-pre-wrap">{n.text}</div>
                 </div>
               ))}
             </div>
          </Card>
        </section>
      </div>

    </div>
  );
}
