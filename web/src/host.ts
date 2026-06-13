/* Démarrage du relais embarqué (app mobile Capacitor + nodejs-mobile).
 *
 * Logique éprouvée en conditions réelles — deux canaux :
 *  1. bridge natif du plugin capacitor-nodejs (rapide quand il marche) ;
 *  2. canal de contrôle HTTP du Node embarqué (127.0.0.1:8788) — le WebView
 *    et Node vivent sur le même appareil, HTTP fonctionne toujours.
 *
 * Pièges connus (appris à la dure, ne pas « simplifier ») :
 *  - la promesse de NodeJS.start() ne se résout PAS tant que le moteur
 *    tourne (le thread natif héberge la boucle Node) : ne jamais l'attendre,
 *    surveiller uniquement son rejet immédiat ;
 *  - les événements natifs arrivent enveloppés : { args: [payload] }.
 */

export interface HostInfo {
  port: number;
  secret: string;
  lanIp: string | null;
  publicUrl: string | null;
}

const CTL = 'http://127.0.0.1:8788';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nodePlugin(): any {
  const C = (window as any).Capacitor;
  if (!C || !C.Plugins) return null;
  return C.Plugins.NodeJS || C.Plugins.CapacitorNodeJS || null;
}

export function isNativeHostAvailable(): boolean {
  return !!nodePlugin();
}

function unwrap(event: any): any {
  if (event && Array.isArray(event.args)) return event.args[0];
  return event;
}

async function ctlFetch(path: string, opts: RequestInit = {}, timeoutMs = 3000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${CTL}${path}`, { ...opts, signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}

async function startViaBridge(payload: object, log: (m: string) => void): Promise<HostInfo> {
  const NodeJS = nodePlugin();
  if (!NodeJS) throw new Error('plugin natif absent');

  const result: Promise<HostInfo> = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge : pas de réponse started (15 s)')), 15000);
    NodeJS.addListener('node-ready', () => log('bridge : projet Node prêt'));
    NodeJS.addListener('log', (e: any) => log(`node: ${unwrap(e)}`));
    NodeJS.addListener('error', (e: any) => { clearTimeout(timer); reject(new Error(String(unwrap(e)))); });
    NodeJS.addListener('started', (e: any) => { clearTimeout(timer); resolve(unwrap(e)); });
  });

  // start() manuel : promesse en vol tant que le moteur tourne (normal) —
  // on ne surveille que son éventuel rejet immédiat (vraie erreur native).
  log('NodeJS.start()…');
  const startFailure: Promise<never> = new Promise((_resolve, reject) => {
    NodeJS.start().then(
      () => log('moteur Node arrêté (start résolu)'),
      (e: any) => {
        const msg = String(unwrap(e) || (e && e.message) || e);
        if (/already been started/i.test(msg)) log('moteur déjà démarré');
        else reject(new Error(`moteur Node : ${msg}`));
      },
    );
  });

  await Promise.race([
    NodeJS.whenReady(),
    startFailure,
    sleep(20000).then(() => { throw new Error('bridge : whenReady muet (20 s)'); }),
  ]);
  log('bridge : whenReady ✅');
  await NodeJS.send({ eventName: 'start', args: [payload] });
  return result;
}

async function startViaHttp(payload: { expose?: boolean }, log: (m: string) => void): Promise<HostInfo> {
  log('canal HTTP : recherche du moteur Node (127.0.0.1:8788)…');
  let diag: any = null;
  for (let i = 0; i < 30 && !diag; i++) {
    try { diag = await ctlFetch('/diag'); } catch { await sleep(1500); }
  }
  if (!diag) {
    throw new Error("moteur Node embarqué injoignable : ni bridge, ni serveur de contrôle. Le moteur natif n'a probablement pas démarré.");
  }
  log(`diag : bridge=${diag.bridge} | ${(diag.steps || []).slice(-2).join(' | ')}`);
  for (const err of diag.errors || []) log(`diag(err) : ${err}`);

  const r = await ctlFetch('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, 30000);
  if (r && r.error) throw new Error(r.error);

  for (let i = 0; i < 20; i++) {
    const st = await ctlFetch('/status').catch(() => null);
    if (st && st.started && (!payload.expose || st.info.publicUrl || i > 10)) return st.info;
    await sleep(1500);
  }
  throw new Error('le relais ne confirme pas son démarrage');
}

// --- survie en arrière-plan : détection constructeur + raccourcis réglages

export interface KeepAliveStatus {
  manufacturer: string;
  ignoringBatteryOptimizations: boolean;
  /** constructeur connu pour tuer les apps en arrière-plan (MIUI & co) */
  aggressive: boolean;
  vendorLabel: string | null;
}

const AGGRESSIVE_VENDORS: Record<string, string> = {
  xiaomi: 'MIUI (Xiaomi/Redmi/POCO)',
  redmi: 'MIUI (Xiaomi/Redmi/POCO)',
  poco: 'MIUI (Xiaomi/Redmi/POCO)',
  huawei: 'EMUI (Huawei)',
  honor: 'Magic UI (Honor)',
  oppo: 'ColorOS (Oppo)',
  realme: 'Realme UI',
  vivo: 'Funtouch (Vivo)',
  oneplus: 'OxygenOS (OnePlus)',
  meizu: 'Flyme (Meizu)',
};

function keepAlivePlugin(): any {
  return (window as any).Capacitor?.Plugins?.KeepAlive || null;
}

export async function keepAliveStatus(): Promise<KeepAliveStatus | null> {
  const KA = keepAlivePlugin();
  if (!KA || !KA.status) return null;
  try {
    const s = await KA.status();
    const vendor = AGGRESSIVE_VENDORS[s.manufacturer] || AGGRESSIVE_VENDORS[s.brand] || null;
    return {
      manufacturer: s.manufacturer,
      ignoringBatteryOptimizations: !!s.ignoringBatteryOptimizations,
      aggressive: !!vendor,
      vendorLabel: vendor,
    };
  } catch { return null; }
}

export async function requestBatteryExemption(): Promise<void> {
  await keepAlivePlugin()?.requestBatteryExemption();
}

export async function openVendorSettings(): Promise<void> {
  await keepAlivePlugin()?.openVendorSettings();
}

export async function startEmbeddedHost(
  expose: boolean,
  log: (m: string) => void,
): Promise<HostInfo> {
  const payload = { port: 8787, expose };
  let info: HostInfo;
  try {
    info = await startViaBridge(payload, log);
    log('démarré via le bridge natif ✅');
  } catch (e: any) {
    // échec NATIF du moteur : la vraie cause prime sur le repli
    if (/^moteur Node :/.test(e.message)) throw e;
    log(`bridge KO (${e.message}) → repli sur le canal HTTP`);
    info = await startViaHttp(payload, log);
    log('démarré via le canal HTTP ✅');
  }
  // service de premier plan + wake lock : le relais survit à l'écran éteint ;
  // le service tient aussi la notification de statut (sessions, messages)
  // en interrogeant le relais nativement (ici en local : 127.0.0.1)
  await startKeepAlive(`http://127.0.0.1:${info.port}`, info.secret,
    localStorage.getItem('cc_channel') || 'default', log);
  return info;
}

// Démarre le service de notifications natif, en visant N'IMPORTE QUEL relais
// (local en mode hébergeur, distant/cloud en mode client) → notifications
// dans les DEUX modes.
export async function startKeepAlive(
  baseUrl: string, token: string, channel: string,
  log: (m: string) => void = () => {},
): Promise<void> {
  try {
    const KA = (window as any).Capacitor?.Plugins?.KeepAlive;
    if (!KA) return; // web/desktop : pas de service natif
    await KA.enable({ baseUrl, token, channel });
    log('🔔 service de notifications actif (' + baseUrl + ')');
  } catch (e: any) {
    log(`keep-alive indisponible : ${e.message || e}`);
  }
}
