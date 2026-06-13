import React, { useState } from 'react';
import { Server, MonitorSmartphone, Radio, AlertCircle, ArrowRight, Copy, Check, Cloud } from 'lucide-react';
import { Card, Input, Button } from './UI';
import { ApiClient } from '../api';
import {
  startEmbeddedHost, isNativeHostAvailable, HostInfo, startKeepAlive,
  keepAliveStatus, requestBatteryExemption, openVendorSettings, KeepAliveStatus,
} from '../host';

function BatteryAdvisor({ status }: { status: KeepAliveStatus }) {
  if (status.ignoringBatteryOptimizations && !status.aggressive) return null;
  return (
    <div className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-200 text-xs space-y-2">
      <p className="font-medium">
        🔋 Pour que le relais survive écran éteint{status.vendorLabel ? ` (${status.vendorLabel} détecté — surcouche agressive)` : ''} :
      </p>
      {!status.ignoringBatteryOptimizations && (
        <button onClick={() => requestBatteryExemption()}
          className="w-full text-left px-3 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-100">
          1. Désactiver l'optimisation batterie pour claude-comm →
        </button>
      )}
      {status.aggressive && (
        <button onClick={() => openVendorSettings()}
          className="w-full text-left px-3 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-100">
          {status.ignoringBatteryOptimizations ? '1' : '2'}. Autoriser le démarrage auto / arrière-plan →
        </button>
      )}
      {status.aggressive && (
        <p className="text-amber-200/70">
          Et verrouille l'app dans les applis récentes (🔒 en maintenant sa carte).
        </p>
      )}
    </div>
  );
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); }
    catch {
      // repli WebView sans API clipboard
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-slate-400">{label}</div>
        <div className="break-all bg-slate-950 p-1.5 rounded font-mono text-emerald-400 text-xs">{value}</div>
      </div>
      <button onClick={copy} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 shrink-0" title="Copier">
        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
}

interface LoginScreenProps {
  onLogin: (base: string, token: string, channel: string) => void;
}

export default function LoginScreen({ onLogin }: LoginScreenProps) {
  const [mode, setMode] = useState<'client' | 'host' | null>(null);
  const [base, setBase] = useState(localStorage.getItem('cc_url') || '');
  const [token, setToken] = useState(localStorage.getItem('cc_token') || '');
  const [channel, setChannel] = useState(localStorage.getItem('cc_channel') || 'default');
  const [pairCode, setPairCode] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [hostExpose, setHostExpose] = useState(false);
  const [hostStatus, setHostStatus] = useState<string>('');
  const [hostInfo, setHostInfo] = useState<any>(null);
  const [kaStatus, setKaStatus] = useState<KeepAliveStatus | null>(null);

  const handleClientLogin = async () => {
    setError('');
    let finalToken = token;
    setLoading(true);

    try {
      const api = new ApiClient(base, token);
      if (!finalToken && pairCode) {
        finalToken = await api.pairCode(pairCode);
        setToken(finalToken);
      }
      if (!finalToken) throw new Error("Saisissez un jeton ou un code d'appairage.");

      localStorage.setItem('cc_url', base);
      localStorage.setItem('cc_token', finalToken);
      localStorage.setItem('cc_channel', channel);
      localStorage.setItem('cc_mode', 'client');

      // mode client (cloud Render, autre tel) : démarre AUSSI le service de
      // notifications natif, pointé sur le relais DISTANT → notifs dans les
      // deux modes (c'est ce qui manquait : avant, notifs en mode hébergeur
      // seulement).
      await startKeepAlive(base, finalToken, channel);

      onLogin(base, finalToken, channel);
    } catch (err: any) {
      setError(err.message || "Erreur de connexion");
    } finally {
      setLoading(false);
    }
  };

  const handleStartHost = async () => {
    setError('');
    if (!isNativeHostAvailable()) {
      setError("Le relais embarqué nécessite l'app native (Android).");
      return;
    }

    setLoading(true);
    const logs: string[] = [];
    const log = (m: string) => {
      logs.push(`${new Date().toLocaleTimeString()} ${m}`);
      setHostStatus(logs.slice(-6).join('\n'));
    };

    try {
      const info: HostInfo = await startEmbeddedHost(hostExpose, log);
      setHostInfo(info);
      setHostStatus('');
      // mémorisé pour le redémarrage automatique du relais (réouverture d'app)
      localStorage.setItem('cc_host_expose', hostExpose ? '1' : '0');
      keepAliveStatus().then(setKaStatus).catch(() => {});
      // pas d'auto-redirection : l'utilisateur copie ses infos puis ouvre
      // le dashboard lui-même ; les infos restent accessibles ensuite (ℹ️)
      localStorage.setItem('cc_mode', 'host');
      localStorage.setItem('cc_host_info', JSON.stringify({
        wifiUrl: `http://${info.lanIp || '?'}:${info.port}`,
        publicUrl: info.publicUrl || '',
        token: info.secret,
        channel: channel || 'default',
      }));
      setLoading(false);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleEnterHostDashboard = () => {
    if (!hostInfo) return;
    localStorage.setItem('cc_url', `http://127.0.0.1:${hostInfo.port}`);
    localStorage.setItem('cc_token', hostInfo.secret);
    localStorage.setItem('cc_channel', channel || 'default');
    onLogin(`http://127.0.0.1:${hostInfo.port}`, hostInfo.secret, channel || 'default');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-950">
      <div className="w-full max-w-md space-y-8">
        
        <div className="text-center space-y-3">
          <div className="inline-flex w-14 h-14 bg-slate-900 border border-white/10 rounded-2xl items-center justify-center mb-2 shadow-lg">
            <Radio className="w-6 h-6 text-slate-100" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">claude-comm</h1>
          <p className="text-slate-400 text-sm">Synchronisation des agents Claude IA</p>
        </div>

        {!mode ? (
          <div className="space-y-4">
            <button
              onClick={() => setMode('client')}
              className="w-full text-left p-5 rounded-2xl border border-white/5 bg-slate-900/50 hover:bg-slate-900 hover:border-white/10 transition-all flex items-center gap-4 group shadow-sm"
            >
              <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-400 shrink-0 group-hover:scale-110 transition-transform">
                <Server className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-slate-200 font-medium mb-1">Se connecter (Client)</h3>
                <p className="text-slate-500 text-xs">Rejoindre un relais existant via URL.</p>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-700 group-hover:text-blue-400 transition-colors" />
            </button>

            <button 
              onClick={() => setMode('host')}
              className="w-full text-left p-5 rounded-2xl border border-white/5 bg-slate-900/50 hover:bg-slate-900 hover:border-white/10 transition-all flex items-center gap-4 group shadow-sm"
            >
              <div className="p-2.5 rounded-xl bg-slate-800 text-slate-300 shrink-0 group-hover:scale-110 transition-transform">
                <MonitorSmartphone className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-slate-200 font-medium mb-1">Héberger un Relais</h3>
                <p className="text-slate-500 text-xs">Lancer sur cet appareil Android.</p>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-700 group-hover:text-slate-300 transition-colors" />
            </button>
          </div>
        ) : (
          <Card className="p-6 relative">
            <button 
              onClick={() => setMode(null)}
              className="text-xs text-slate-500 hover:text-slate-300 mb-6 flex items-center transition-colors"
            >
              &larr; Retour
            </button>

            {mode === 'client' && (
              <div className="space-y-5">
                <a
                  href="https://render.com/deploy?repo=https://github.com/aciderix/claude-communicator"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 hover:bg-emerald-500/15 transition-colors"
                >
                  <Cloud className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-emerald-200">Pas encore de relais cloud ?</div>
                    <div className="text-xs text-emerald-300/70">Déployer gratuitement sur Render (URL fixe, ~3 min) →</div>
                  </div>
                </a>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wide">URL du relais</label>
                  <Input
                    value={base}
                    onChange={e => setBase(e.target.value)}
                    placeholder="https://mon-relais.onrender.com"
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wide">Authentification</label>
                  <div className="grid grid-cols-2 gap-3">
                    <Input 
                      value={pairCode} 
                      onChange={e => setPairCode(e.target.value)} 
                      placeholder="Code (6 chiffres)" 
                      maxLength={6}
                    />
                    <Input 
                      type="password"
                      value={token} 
                      onChange={e => setToken(e.target.value)} 
                      placeholder="Ou Jeton long" 
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wide">Canal</label>
                  <Input 
                    value={channel} 
                    onChange={e => setChannel(e.target.value)} 
                    placeholder="default" 
                    className="w-full"
                  />
                </div>
                
                {error && (
                  <div className="p-3 rounded-lg border border-rose-500/20 bg-rose-500/10 text-rose-400 text-sm flex gap-3 shadow-inner">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                
                <Button variant="primary" className="w-full py-2.5 mt-2 shadow-blue-900/20 shadow-lg" onClick={handleClientLogin} loading={loading}>
                  Entrer dans l'espace de travail
                </Button>
              </div>
            )}

            {mode === 'host' && (
              <div className="space-y-5">
                <div className="p-4 rounded-xl border border-white/5 bg-slate-950">
                  <label className="flex items-start gap-4 cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="mt-1 w-4 h-4 rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-offset-slate-950" 
                      checked={hostExpose}
                      onChange={e => setHostExpose(e.target.checked)}
                    />
                    <div>
                      <span className="block text-sm font-medium text-slate-100">Exposer le relais</span>
                      <span className="block text-xs text-slate-500 mt-1 leading-relaxed">Rend le relais accessible depuis internet, idéal si vous n'êtes pas sur le même réseau WiFi.</span>
                    </div>
                  </label>
                </div>
                
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wide">Canal de démarrage</label>
                  <Input 
                    value={channel} 
                    onChange={e => setChannel(e.target.value)} 
                    placeholder="default" 
                    className="w-full"
                  />
                </div>

                {hostStatus && (
                  <div className="p-3 rounded-lg bg-[#000] border border-slate-800 text-slate-300 text-xs font-mono whitespace-pre-wrap">
                    {hostStatus}
                  </div>
                )}
                {hostInfo && (
                  <div className="p-3 rounded-lg border border-white/10 bg-slate-900 text-slate-200 text-sm space-y-3 shadow-inner">
                    <CopyRow label="Local (WiFi)" value={`http://${hostInfo.lanIp || '?'}:${hostInfo.port}`} />
                    {hostInfo.publicUrl && <CopyRow label="Public (Internet)" value={hostInfo.publicUrl} />}
                    <CopyRow label="Jeton secret" value={hostInfo.secret} />
                    <p className="text-xs text-slate-500">
                      Ces infos restent disponibles dans le dashboard (bouton ℹ️).
                      Sessions PC : CLAUDE_COMM_RELAY=&lt;url&gt; CLAUDE_COMM_TOKEN=&lt;jeton&gt; claude
                    </p>
                  </div>
                )}
                {hostInfo && kaStatus && <BatteryAdvisor status={kaStatus} />}
                {error && (
                  <div className="p-3 rounded-lg border border-rose-500/20 bg-rose-500/10 text-rose-400 text-sm flex gap-3">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {!hostInfo ? (
                  <Button variant="primary" className="w-full mt-2 py-2.5" onClick={handleStartHost} loading={loading}>
                    Démarrer le Relais
                  </Button>
                ) : (
                  <Button variant="primary" className="w-full mt-2 py-2.5" onClick={handleEnterHostDashboard}>
                    Ouvrir le dashboard →
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
