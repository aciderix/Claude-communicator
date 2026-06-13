import React, { useEffect, useState, useRef } from 'react';
import { ApiClient } from '../api';
import { AppState } from '../types';
import SessionsList from './SessionsList';
import TasksPlan from './TasksPlan';
import ConversationThread from './ConversationThread';
import QuestionsList from './QuestionsList';
import MiscLists from './MiscLists';
import ChannelSelect from './ChannelSelect';
import { Button, Input, Card, Badge } from './UI';
import { LogOut, Activity, Map, MessageSquareText, MessageSquareDashed, X, FolderTree, Radio, Info, Timer } from 'lucide-react';
import { CopyRow } from './LoginScreen';
import { startEmbeddedHost, isNativeHostAvailable, startKeepAlive } from '../host';

export default function Dashboard({
  base,
  token,
  defaultChannel,
  onLogout
}: {
  base: string;
  token: string;
  defaultChannel: string;
  onLogout: () => void
}) {
  const [channel, setChannel] = useState(defaultChannel);
  const [state, setState] = useState<AppState | null>(null);
  const [currentView, setCurrentView] = useState<'overview' | 'plan' | 'questions' | 'messages' | 'system'>('overview');
  
  const [statusMsg, setStatusMsg] = useState('Connexion...');
  const [errorStatus, setErrorStatus] = useState<boolean>(false);
  
  const [standup, setStandup] = useState(0);

  // Diff Modal State
  const [diffPeer, setDiffPeer] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string>('Chargement...');

  // Infos d'hébergement (app en mode hôte) : URL, jeton… toujours accessibles
  const [showHostInfo, setShowHostInfo] = useState(false);
  // Infos de connexion, disponibles dans LES DEUX modes :
  //  - hébergeur : URL WiFi + publique + jeton (depuis cc_host_info)
  //  - client (cloud/distant) : l'URL du relais + le jeton de connexion
  const connInfo = (() => {
    const isHost = localStorage.getItem('cc_mode') === 'host';
    if (isHost) {
      try {
        const h = JSON.parse(localStorage.getItem('cc_host_info') || 'null');
        if (h) return { mode: 'host', wifiUrl: h.wifiUrl, publicUrl: h.publicUrl, url: h.publicUrl || h.wifiUrl, token: h.token };
      } catch { /* ignore */ }
    }
    if (base && token) return { mode: 'client', url: base, token };
    return null;
  })();

  const [standupDraft, setStandupDraft] = useState<string | null>(null);
  const [standupSaved, setStandupSaved] = useState(false);

  const versionRef = useRef(0);
  const runningRef = useRef(true);
  const restartingRef = useRef(false);
  const api = new ApiClient(base, token);

  useEffect(() => {
    runningRef.current = true;
    versionRef.current = 0;
    setState(null);

    // mode client (relais distant/cloud) : a la reouverture de l'app on
    // arrive directement ici (LoginScreen saute), il faut donc (re)demarrer
    // le service de notifications natif pointe sur le relais distant.
    if (localStorage.getItem('cc_mode') === 'client' && base && !base.includes('127.0.0.1')) {
      startKeepAlive(base, token, channel);
    }


    const poll = async () => {
      let failures = 0;
      while (runningRef.current) {
        try {
          const s = await api.getState(channel, versionRef.current);
          if (!runningRef.current) break;
          failures = 0;
          versionRef.current = s.version;
          setState(s);
          setStandup(s.config?.standup_minutes || 0);
          setStatusMsg(`Connecté · v${s.version}`);
          setErrorStatus(false);
        } catch (e: any) {
          if (!runningRef.current) break;
          failures++;
          setErrorStatus(true);
          if (String(e.message).includes('401')) {
            runningRef.current = false;
            onLogout();
            return;
          }
          // mode hôte : le relais vit dans CE processus — si l'app a été
          // tuée (fermeture prolongée), on le redémarre automatiquement
          if (failures >= 2 && !restartingRef.current &&
              localStorage.getItem('cc_mode') === 'host' &&
              base.includes('127.0.0.1') && isNativeHostAvailable()) {
            restartingRef.current = true;
            setStatusMsg('Relais arrêté — redémarrage automatique…');
            try {
              const expose = localStorage.getItem('cc_host_expose') === '1';
              const info = await startEmbeddedHost(expose, (m) => setStatusMsg(m));
              localStorage.setItem('cc_host_info', JSON.stringify({
                wifiUrl: `http://${info.lanIp || '?'}:${info.port}`,
                publicUrl: info.publicUrl || '',
                token: info.secret,
                channel,
              }));
              setStatusMsg('Relais redémarré ✅');
              failures = 0;
            } catch (err: any) {
              setStatusMsg(`Redémarrage impossible : ${err.message}`);
            }
            restartingRef.current = false;
          } else {
            setStatusMsg(`Erreur : ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    };

    poll();

    // Android suspend le JS du WebView en arrière-plan : au retour au
    // premier plan, on force un état frais sans attendre le long-poll gelé.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      api.getState(channel, 0).then((s) => {
        if (!runningRef.current) return;
        versionRef.current = s.version;
        setState(s);
        setStandup(s.config?.standup_minutes || 0);
        setStatusMsg(`Connecté · v${s.version}`);
        setErrorStatus(false);
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      runningRef.current = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [base, token, channel]);

  const loadDiff = async (peer: string, mode: string) => {
    setDiffPeer(peer);
    setDiffContent(`Chargement du diff (${mode})...`);
    const res = await api.requestDiff(channel, peer, mode);
    if (!runningRef.current) return;
    if (res.ok) setDiffContent(res.result || 'Aucun changement remonté.');
    else setDiffContent(`❌ ${res.error || 'Pas de réponse.'}`);
  };

  const navItems = [
    { id: 'overview', label: "Vue d'ensemble", icon: Activity },
    { id: 'plan', label: 'Feuille de route', icon: Map },
    { id: 'questions', label: 'Requêtes', icon: MessageSquareDashed },
    { id: 'messages', label: 'Messages', icon: MessageSquareText },
    { id: 'system', label: 'Système', icon: FolderTree },
  ] as const;

  const openQuestionsCount = state?.user?.questions?.items?.filter(q => q.status === 'open').length || 0;

  return (
    <div className="flex flex-col md:flex-row h-screen bg-slate-950 text-slate-300 font-sans pt-safe">
      
      {/* DESKTOP SIDEBAR */}
      <aside className="hidden md:flex w-64 flex-col bg-slate-900 border-r border-slate-800/60 z-20 shrink-0">
        <div className="p-6">
          <div className="flex items-center gap-3 text-slate-100 font-medium tracking-tight mb-1">
            <Radio className="w-5 h-5 text-slate-400" /> claude-comm
          </div>
          <div className="flex items-center gap-2 mt-2">
            <span className={`w-2 h-2 rounded-full ${errorStatus ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`}></span>
            <span className={`text-xs ${errorStatus ? 'text-rose-400' : 'text-slate-400'} truncate`}>{statusMsg}</span>
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
          {navItems.map(item => {
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentView(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  isActive ? 'bg-slate-800/80 text-white shadow-sm border border-white/5' : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                }`}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.id === 'questions' && openQuestionsCount > 0 && (
                  <span className="bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">{openQuestionsCount}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800/60 space-y-4">
          {connInfo && (
            <Button variant="ghost" onClick={() => setShowHostInfo(true)} className="w-full justify-start h-9 text-slate-300">
              <Info className="w-4 h-4" /> Infos de connexion
            </Button>
          )}
          <div className="space-y-2">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Canal Actif</label>
            <ChannelSelect
              channel={channel}
              direction="up"
              onSelect={(c) => { localStorage.setItem('cc_channel', c); setChannel(c); }}
              fetchChannels={() => api.getChannels()}
            />
          </div>
          <Button variant="ghost" onClick={onLogout} className="w-full justify-start text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 h-9">
            <LogOut className="w-4 h-4" /> Menu principal
          </Button>
        </div>
      </aside>

      {/* MOBILE TOP HEADER */}
      <header className="md:hidden flex items-center justify-between p-4 bg-slate-900 border-b border-slate-800/60 shrink-0 z-20">
        <div className="flex items-center gap-2 font-medium text-slate-100">
          <Radio className="w-5 h-5 text-slate-400" /> <span className="text-sm">claude-comm</span>
        </div>
        <div className="flex flex-col items-end gap-2">
           <div className="flex items-center gap-2">
             {connInfo && (
               <button onClick={() => setShowHostInfo(true)} className="text-slate-400 hover:text-slate-200 p-1" title="Infos de connexion">
                 <Info className="w-4 h-4" />
               </button>
             )}
             <span className={`w-1.5 h-1.5 rounded-full ${errorStatus ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500'}`}></span>
             <ChannelSelect
               channel={channel}
               direction="down"
               compact
               onSelect={(c) => { localStorage.setItem('cc_channel', c); setChannel(c); }}
               fetchChannels={() => api.getChannels()}
             />
             <button onClick={onLogout} className="text-slate-400 hover:text-rose-400 p-1" title="Menu principal (changer de mode)">
               <LogOut className="w-4 h-4" />
             </button>
           </div>
        </div>
      </header>

      {/* MAIN VIEW AREA */}
      <main className="flex-1 flex flex-col h-full overflow-hidden relative pb-[65px] md:pb-0 z-10 bg-slate-950">
        {!state ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-4">
             <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-white/5 flex items-center justify-center animate-pulse">
               <Activity className="w-6 h-6 text-slate-500" />
             </div>
             <p className="text-slate-500 font-mono text-sm">Chargement du canal...</p>
          </div>
        ) : (
          <div className={`flex-1 min-h-0 overflow-x-hidden custom-scrollbar flex flex-col ${currentView === 'messages' ? 'overflow-y-hidden p-0 md:p-6 pb-0 md:pb-0' : 'overflow-y-auto p-4 md:p-8'}`}>
            <div className={`max-w-5xl mx-auto w-full ${currentView === 'messages' ? 'flex-1 min-h-0 flex flex-col' : 'space-y-8 pb-12'}`}>

              {/* VIEW: OVERVIEW */}
              {currentView === 'overview' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <SessionsList sessions={state.sessions} onDiffClick={(peer) => loadDiff(peer, 'stat')} />
                </div>
              )}

              {/* VIEW: PLAN */}
              {currentView === 'plan' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <TasksPlan plan={state.plan} tasks={state.tasks?.tasks || []} />
                </div>
              )}

              {/* VIEW: QUESTIONS */}
              {currentView === 'questions' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <QuestionsList 
                    questions={state.user?.questions?.items || []} 
                    onAnswer={(id, text) => { api.answerQuestion(channel, id, text); }} 
                  />
                </div>
              )}

              {/* VIEW: MESSAGES */}
              {currentView === 'messages' && (
                <div className="flex-1 min-h-0 animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col">
                  <ConversationThread 
                    msgs={state.user?.msgs?.items || []} 
                    sessions={state.sessions}
                    onSend={(to, body) => { api.postMsg(channel, to, body); }}
                  />
                </div>
              )}

              {/* VIEW: SYSTEM */}
              {currentView === 'system' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">
                  <Card className="p-5">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2 text-slate-200 font-medium">
                        <Timer className="w-4 h-4 text-slate-400" /> Standup périodique
                      </div>
                      <Input
                        value={standupDraft ?? String(standup)}
                        onChange={e => setStandupDraft(e.target.value)}
                        className="w-20 text-center"
                      />
                      <span className="text-xs text-slate-500">minutes (0 = désactivé)</span>
                      <Button
                        variant="secondary"
                        className="h-8 text-xs"
                        onClick={async () => {
                          await api.setStandup(channel, Number(standupDraft ?? standup) || 0);
                          setStandupDraft(null);
                          setStandupSaved(true);
                          setTimeout(() => setStandupSaved(false), 2000);
                        }}
                      >
                        {standupSaved ? '✅ Enregistré' : 'Enregistrer'}
                      </Button>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                      Digest compact diffusé aux sessions, uniquement si l'état a changé (économie de tokens).
                    </p>
                  </Card>
                  <MiscLists
                    reviews={state.reviews?.items || []}
                    locks={state.locks || []}
                    notes={state.notes_tail || []}
                  />
                </div>
              )}

            </div>
          </div>
        )}
      </main>

      {/* MOBILE BOTTOM NAV */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-[65px] bg-slate-900 border-t border-slate-800/60 pb-safe z-30 flex items-center justify-around px-2">
         {navItems.map(item => {
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentView(item.id)}
                className={`flex flex-col items-center justify-center p-2 min-w-[50px] flex-1 transition-colors relative ${
                  isActive ? 'text-white' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <item.icon className={`w-5 h-5 mb-1 ${isActive ? 'stroke-[2.5px]' : ''}`} />
                <span className="text-[10px] font-medium">{item.label.split(' ')[0]}</span>
                {item.id === 'questions' && openQuestionsCount > 0 && (
                  <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-blue-500"></span>
                )}
              </button>
            );
          })}
      </nav>

      {/* HOST INFO MODAL */}
      {showHostInfo && connInfo && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[#050505]/80 backdrop-blur-sm" onClick={() => setShowHostInfo(false)}></div>
          <Card className="relative w-full max-w-md max-h-[85vh] overflow-y-auto custom-scrollbar p-5 border border-slate-800 shadow-2xl bg-[#0d1117] space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-slate-200 uppercase tracking-wider text-xs">
                Connexion d'autres appareils {connInfo.mode === 'client' ? '· relais distant' : ''}
              </h3>
              <button onClick={() => setShowHostInfo(false)} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-slate-800 text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            {connInfo.mode === 'host' && connInfo.wifiUrl && <CopyRow label="Local (WiFi)" value={connInfo.wifiUrl} />}
            {connInfo.mode === 'host' && connInfo.publicUrl && <CopyRow label="Public (Internet)" value={connInfo.publicUrl} />}
            <CopyRow label={connInfo.mode === 'client' ? 'URL du relais' : 'URL publique'} value={connInfo.url || ''} />
            <CopyRow label="Jeton secret" value={connInfo.token || ''} />
            <CopyRow label="Canal" value={channel} />

            <div className="pt-3 border-t border-slate-800 space-y-3">
              <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                Connecter des sessions Claude (MCP)
              </p>
              <CopyRow
                label="Session ponctuelle — à coller dans un terminal du projet"
                value={`CLAUDE_COMM_NAME=alice CLAUDE_COMM_CHANNEL=${channel} CLAUDE_COMM_RELAY=${connInfo.url} CLAUDE_COMM_TOKEN=${connInfo.token} claude`}
              />
              <CopyRow
                label="Machine entière 1/2 — mémoriser la connexion"
                value={`node server.js login ${connInfo.url} ${connInfo.token} ${channel}`}
              />
              <CopyRow
                label="Machine entière 2/2 — outils comm_* dans tous les projets"
                value="claude mcp add comm --scope user -- node /chemin/claude-communicator/server.js"
              />
              <CopyRow
                label="Connecteur claude.ai (web/mobile) — URL du serveur MCP distant"
                value={`${connInfo.url}/mcp/${connInfo.token}/${encodeURIComponent(channel)}/claude-web`}
              />
              <p className="text-xs text-slate-500">
                server.js vient du dépôt claude-communicator (git clone, aucun npm install).
                Après l'étape « machine entière », il suffit de lancer <span className="font-mono text-slate-400">claude</span> —
                noms de session auto-générés, coordination via le protocole PROTOCOL.md.
              </p>
            </div>
          </Card>
        </div>
      )}

      {/* DIFF MODAL */}
      {diffPeer && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
           <div className="absolute inset-0 bg-[#050505]/80 backdrop-blur-sm" onClick={() => setDiffPeer(null)}></div>
           <Card className="relative w-full max-w-3xl max-h-[85vh] flex flex-col p-0 border border-slate-800 shadow-2xl bg-[#0d1117]">
             <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/60 shrink-0 bg-slate-900/50">
               <h3 className="font-medium text-slate-200 uppercase tracking-wider text-xs">Différence de &quot;{diffPeer}&quot;</h3>
               <div className="flex items-center gap-2">
                 <Button variant="secondary" onClick={() => loadDiff(diffPeer, 'stat')} className="h-7 py-1 text-xs">Stat</Button>
                 <Button variant="secondary" onClick={() => loadDiff(diffPeer, 'full')} className="h-7 py-1 text-xs">Complet</Button>
                 <button onClick={() => setDiffPeer(null)} className="ml-2 w-7 h-7 flex items-center justify-center rounded-full hover:bg-slate-800 text-slate-400 hover:text-white transition-colors">
                   <X className="w-4 h-4" />
                 </button>
               </div>
             </div>
             <div className="flex-1 overflow-auto p-5 relative">
               <pre className="font-mono text-[11px] md:text-xs text-slate-300 whitespace-pre-wrap word-break-all break-all overflow-y-auto leading-relaxed">
                 {diffContent}
               </pre>
             </div>
           </Card>
        </div>
      )}
    </div>
  );
}
