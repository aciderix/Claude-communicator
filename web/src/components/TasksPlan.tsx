import React from 'react';
import { Plan, Task } from '../types';
import { Card, Badge } from './UI';
import { Map, CheckSquare, Hexagon, Maximize2, MoreHorizontal } from 'lucide-react';

export default function TasksPlan({ plan, tasks }: { plan: Plan, tasks: Task[] }) {
  const allTasks = tasks || [];
  const milestones = plan?.milestones || [];
  
  const mStatusColor = { 
    todo: 'border-slate-800 text-slate-500',
    active: 'border-blue-500/50 text-blue-400 bg-blue-500/10',
    done: 'border-emerald-500/30 text-emerald-500 bg-emerald-500/5',
    dropped: 'border-rose-500/30 text-rose-500 bg-rose-500/5'
  } as Record<string, string>;

  return (
    <div className="max-w-4xl space-y-8">
      {/* GOAL BANNER */}
      <div className="p-6 rounded-2xl bg-gradient-to-r from-blue-900/20 to-slate-900 border border-blue-500/10 text-center">
        <h3 className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2 flex justify-center items-center gap-2">
           <Map className="w-4 h-4" /> Cap Actuel
        </h3>
        <p className="text-lg md:text-xl text-slate-200 font-medium">
          {plan?.goal || "Trajectoire principale non définie."}
        </p>
      </div>

      <div className="space-y-4">
        {milestones.length === 0 && <p className="text-center text-slate-500 text-sm py-8 border border-dashed border-slate-800 rounded-xl">Aucun jalon défini</p>}
        
        {milestones.map((m, idx) => {
           const mTasks = allTasks.filter(t => t.milestone === m.id);
           const isDone = m.status === 'done';
           
           return (
             <Card key={m.id} className={`p-0 bg-transparent flex flex-col md:flex-row shadow-none border ${isDone ? 'opacity-60 border-slate-800' : 'border-white/5 bg-slate-900/20'}`}>
               
               {/* MILESTONE HEADER (Left Col) */}
               <div className="p-5 md:w-1/3 shrink-0 flex flex-col justify-start border-b md:border-b-0 md:border-r border-slate-800/60 bg-slate-900/40">
                  <div className="flex items-center gap-2 mb-2">
                     <span className={`flex items-center justify-center w-6 h-6 rounded-md border text-xs font-bold ${mStatusColor[m.status] || mStatusColor.todo}`}>
                       {idx + 1}
                     </span>
                     <span className="font-mono text-xs text-slate-400 uppercase tracking-widest">{m.id}</span>
                  </div>
                  <h4 className={`text-base font-medium ${isDone ? 'text-slate-400' : 'text-slate-200'} leading-snug`}>{m.title}</h4>
                  {m.detail && <p className="text-xs text-slate-500 mt-2 leading-relaxed">{m.detail}</p>}
               </div>

               {/* TASKS LIST (Right Col) */}
               <div className="p-5 flex-1 space-y-3">
                 {mTasks.length === 0 ? (
                   <p className="text-xs text-slate-500 flex items-center gap-2"><MoreHorizontal className="w-4 h-4" /> Pas de tâches définies</p>
                 ) : (
                   mTasks.map(t => (
                     <div key={t.id} className="flex gap-3 group">
                        <div className="shrink-0 mt-0.5">
                           {t.status === 'done' ? (
                              <CheckSquare className="w-4 h-4 text-emerald-500/70" />
                           ) : t.status === 'in_progress' ? (
                              <div className="w-4 h-4 border-2 border-blue-400 rounded-sm bg-blue-400/20" />
                           ) : t.status === 'blocked' ? (
                              <Hexagon className="w-4 h-4 text-rose-500" />
                           ) : (
                              <div className="w-4 h-4 border-2 border-slate-700 rounded-sm" />
                           )}
                        </div>
                        <div className="min-w-0">
                           <div className="flex flex-wrap items-baseline gap-2">
                             <span className={`text-sm ${t.status==='done' ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{t.title}</span>
                             <span className="text-[10px] font-mono text-slate-600">{t.id}</span>
                           </div>
                           
                           {/* Task Metadata */}
                           <div className="flex flex-wrap items-center gap-2 mt-1">
                             {t.owner && <Badge variant="idle" className="py-0 text-[10px] bg-transparent border-slate-800">{t.owner}</Badge>}
                             {t.deps && t.deps.length > 0 && <span className="text-[10px] text-slate-500 flex items-center gap-1"><Maximize2 className="w-3 h-3"/> {t.deps.join(', ')}</span>}
                           </div>
                           
                           {/* Notes */}
                           {t.notes && t.notes.length > 0 && (
                             <div className="mt-1.5 p-2 rounded-lg bg-slate-950/50 border border-slate-800/50 text-xs text-slate-400 italic">
                               {t.notes[t.notes.length - 1]}
                             </div>
                           )}
                        </div>
                     </div>
                   ))
                 )}
               </div>
             </Card>
           );
        })}
      </div>
    </div>
  );
}
