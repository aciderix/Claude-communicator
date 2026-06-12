import React, { useState } from 'react';
import { Question } from '../types';
import { Card, Button, Input } from './UI';
import { CornerDownRight, MessageSquareDashed } from 'lucide-react';

interface QuestionsListProps {
  questions: Question[];
  onAnswer: (id: string, text: string) => void;
}

export default function QuestionsList({ questions, onAnswer }: QuestionsListProps) {
  const [answersMap, setAnswersMap] = useState<Record<string, string>>({});
  const allQ = [...(questions || [])].reverse();
  const openQ = allQ.filter(q => q.status === 'open');

  if (openQ.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center text-slate-500 border border-dashed border-slate-800 rounded-2xl bg-slate-900/20">
        <MessageSquareDashed className="w-8 h-8 mb-4 opacity-20"/>
        <p className="text-sm">Aucune requête en attente de réponse.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 mb-8">
      <div className="flex items-center gap-2 text-slate-400 uppercase tracking-widest text-xs font-semibold px-1">
         <MessageSquareDashed className="w-4 h-4 text-blue-400" /> Requêtes d'IA en attente
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {openQ.map(q => (
           <Card key={q.id} className="border-l-2 border-l-blue-500 p-4 bg-slate-900 border-y border-r border-white/5 space-y-3 shadow-md relative overflow-visible">
             <div className="text-[10px] text-slate-400 font-mono uppercase tracking-widest">
               De: {q.from}
             </div>
             
             <p className="text-sm font-medium text-slate-200 leading-snug">{q.text}</p>
             {q.context && <p className="text-xs text-slate-500 bg-slate-950 rounded-md p-2 border border-slate-800">{q.context}</p>}
             
             <div className="pt-2 flex flex-col gap-2">
               {q.options && q.options.length > 0 && (
                 <div className="flex flex-wrap gap-2">
                   {q.options.map(opt => (
                     <Button key={opt} variant="secondary" onClick={() => onAnswer(q.id, opt)} className="py-1 px-3 text-xs bg-slate-800/50">
                       {opt}
                     </Button>
                   ))}
                 </div>
               )}
               <div className="flex gap-2">
                 <Input 
                   className="flex-1 py-1 px-3 text-xs h-8"
                   placeholder="Réponse libre..."
                   value={answersMap[q.id] || ''}
                   onChange={e => setAnswersMap(prev => ({...prev, [q.id]: e.target.value}))}
                   onKeyDown={e => {
                     if (e.key === 'Enter') {
                       onAnswer(q.id, answersMap[q.id] || '');
                       setAnswersMap(prev => ({...prev, [q.id]: ''}));
                     }
                   }}
                 />
                 <Button 
                   variant="ghost"
                   className="h-8 px-2 text-blue-400 hover:text-blue-300"
                   onClick={() => {
                      onAnswer(q.id, answersMap[q.id] || '');
                      setAnswersMap(prev => ({...prev, [q.id]: ''}));
                   }}
                   title="Envoyer la réponse"
                 >
                   <CornerDownRight className="w-4 h-4"/>
                 </Button>
               </div>
             </div>
           </Card>
        ))}
      </div>
    </div>
  );
}
