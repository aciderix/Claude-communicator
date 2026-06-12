import React from 'react';
import { Session } from '../types';
import { Card, Badge, Button } from './UI';
import { Activity, Server, FileCode2, Clock, CheckCircle2, MoreHorizontal } from 'lucide-react';

function timeAgo(iso?: string) {
  if (!iso) return '?';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!isFinite(s)) return '?';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

export default function SessionsList({ sessions, onDiffClick }: { sessions: Session[], onDiffClick: (peer: string) => void }) {
  if (!sessions || sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center text-slate-500 border border-dashed border-slate-800 rounded-2xl bg-slate-900/20">
        <Activity className="w-8 h-8 mb-4 opacity-20"/>
        <p className="text-sm">Aucun agent ou session n'est connecté à ce relais.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {sessions.map(s => {
        const isSilent = s.live && s.last_model_seen && (Date.now() - Date.parse(s.last_model_seen) > 10 * 60 * 1000) && !['done', 'offline'].includes(s.state || '');
        const isCompactedRecently = s.compacted_at && (Date.now() - Date.parse(s.compacted_at) < 30 * 60 * 1000);

        let sBadge = 'idle';
        if (s.state === 'working') sBadge = 'ok';
        else if (s.state === 'blocked' || s.state === 'offline') sBadge = 'bad';
        else if (s.state === 'done' || s.state === 'reviewing') sBadge = 'purple';

        return (
          <Card key={s.name} className="flex flex-col group p-5 hover:bg-slate-900 transition-colors">
            {/* Header info */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full shrink-0 mt-2 ${s.live ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-600'}`}></div>
                <div>
                  <h3 className="font-semibold text-slate-200 leading-tight">{s.name}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{s.role || "Rôle non défini"}</p>
                </div>
              </div>
              <Badge variant={sBadge as any} className="uppercase tracking-widest">{s.state || 'idle'}</Badge>
            </div>

            {/* Task Info */}
            <div className="flex-1 bg-[#0d1117] rounded-xl p-3 border border-white/[0.02] mb-4">
              {s.task ? (
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-sm text-slate-300">{s.task}</span>
                    {s.progress && <span className="text-xs text-slate-500 ml-2 font-mono">({s.progress})</span>}
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 opacity-50">
                   <MoreHorizontal className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                   <span className="text-sm text-slate-500 italic">En attente d'affectation...</span>
                </div>
              )}
            </div>

            {/* Footer Metadata & Actions */}
            <div className="flex items-end justify-between mt-auto">
              <div className="space-y-1.5 flex-1">
                {/* Minor tags */}
                <div className="flex flex-wrap gap-2 text-[10px] text-slate-500 font-mono">
                  {s.host && <span className="flex items-center gap-1 bg-slate-800/50 px-1.5 py-0.5 rounded"><Server className="w-3 h-3"/> {s.host}</span>}
                  {(s.branch || s.head) && <span className="flex items-center gap-1 bg-slate-800/50 px-1.5 py-0.5 rounded"><FileCode2 className="w-3 h-3"/> {s.branch || '?'}@{s.head?.slice(0,6) || '?'}</span>}
                  <span className="flex items-center gap-1 bg-slate-800/50 px-1.5 py-0.5 rounded"><Clock className="w-3 h-3"/> {timeAgo(s.last_seen)}</span>
                </div>
                {/* Warnings */}
                <div className="flex flex-wrap gap-2">
                  {isSilent && <span className="text-[10px] text-amber-500/80 bg-amber-500/10 px-1.5 py-0.5 rounded flex items-center">Silence modèle {timeAgo(s.last_model_seen)}</span>}
                  {s.compacting ? (
                     <span className="text-[10px] text-purple-400/80 bg-purple-500/10 px-1.5 py-0.5 rounded flex items-center animate-pulse">Compaction en cours...</span>
                  ) : isCompactedRecently ? (
                     <span className="text-[10px] text-slate-400 bg-slate-800/80 px-1.5 py-0.5 rounded flex items-center">Compacté {timeAgo(s.compacted_at)}</span>
                  ) : null}
                </div>
              </div>
              
              <Button variant="ghost" className="h-8 text-xs shrink-0 bg-slate-800/40 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => onDiffClick(s.name)}>
                Diff
              </Button>
            </div>

          </Card>
        );
      })}
    </div>
  );
}
