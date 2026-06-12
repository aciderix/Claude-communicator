import React, { useState, useRef, useEffect } from 'react';
import { Msg, Session, Reply } from '../types';
import { Card, Button, Input } from './UI';
import { Send, CornerDownRight } from 'lucide-react';

function timeStr(iso?: string) {
  if (!iso) return '';
  return new Date(Date.parse(iso)).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}

export default function ConversationThread({ msgs, sessions, onSend }: { msgs: Msg[], sessions: Session[], onSend: (to: string, text: string) => void }) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState('*');
  const scrollEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom when messages change
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  const handleSend = () => {
    if (text.trim()) {
      onSend(target, text.trim());
      setText('');
    }
  };

  return (
    <Card className="flex flex-col flex-1 h-full min-h-0 p-0 border-0 md:border md:border-slate-800/60 bg-slate-900/40 rounded-none md:rounded-2xl">
      <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-5 space-y-6 custom-scrollbar">
        {(!msgs || msgs.length === 0) ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            Aucun message. Commencez à écrire.
          </div>
        ) : (
          msgs.map(m => (
            <div key={m.id} className="flex flex-col gap-2">
              {/* Dev User Message */}
              <div className="flex justify-end">
                <div className="max-w-[85%] bg-blue-600/20 border border-blue-500/20 text-blue-100 rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm shadow-sm backdrop-blur-sm">
                  <div className="text-blue-300 text-[10px] font-mono mb-1 uppercase tracking-wider flex justify-between gap-4">
                     <span>À: {m.to}</span>
                     <span className="opacity-70">{timeStr(m.ts)}</span>
                  </div>
                  <div className="whitespace-pre-wrap">{m.body}</div>
                  {m.status === 'claimed' && m.claimed_by && (
                    <div className="mt-2 text-xs text-blue-400 border-t border-blue-500/20 pt-1.5 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
                      {m.claimed_by} rédige une réponse...
                    </div>
                  )}
                </div>
              </div>
              
              {/* Agent Replies */}
              {(m.replies || []).map((r: Reply, idx: number) => (
                <div key={idx} className="flex justify-start">
                  <div className="max-w-[85%] bg-[#1b2028] border border-white/5 text-slate-200 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm shadow-sm">
                    <div className="text-slate-400 text-[10px] font-mono mb-1 flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></div>
                      <span className="uppercase tracking-wider">{r.by}</span>
                      <span className="opacity-50 ml-auto">{timeStr(r.ts)}</span>
                    </div>
                    <div className="whitespace-pre-wrap leading-relaxed">{r.body}</div>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
        <div ref={scrollEndRef} />
      </div>

      <div className="p-4 bg-slate-900 border-t border-slate-800/60 shrink-0">
        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl overflow-hidden focus-within:ring-1 focus-within:ring-blue-500/50 transition-shadow">
          <select 
            value={target} 
            onChange={e => setTarget(e.target.value)}
            className="bg-transparent text-slate-400 text-xs px-3 focus:outline-none border-none outline-none h-11 font-mono hover:text-slate-200 cursor-pointer"
          >
            <option value="*">@Tous</option>
            {sessions.map(s => <option key={s.name} value={s.name}>@{s.name}</option>)}
          </select>
          <div className="w-px h-6 bg-slate-800"></div>
          <Input 
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
            placeholder="Tapez un message..."
            className="flex-1 border-none shadow-none focus:ring-0 rounded-none bg-transparent h-11 px-4 text-sm"
          />
          <button 
            onClick={handleSend} 
            disabled={!text.trim()}
            className="h-11 px-4 text-blue-500 hover:bg-blue-500/10 focus:outline-none disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </Card>
  );
}
