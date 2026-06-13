import React, { useState } from 'react';
import { X, HelpCircle, Server, MonitorSmartphone, Bell, Database, BatteryCharging, Users, ChevronRight } from 'lucide-react';
import { Card } from './UI';

/**
 * Aide consolidee : un seul endroit ou l'utilisateur retrouve TOUT ce qu'il
 * faut savoir pour utiliser claude-comm clairement. Accessible depuis l'ecran
 * de connexion ET depuis le dashboard. Les sections sont des accordeons pour
 * rester lisibles sur mobile.
 */

function Section({ icon: Icon, title, children, defaultOpen = false }: {
  icon: any; title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-white/5 bg-slate-900/50 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 p-3.5 text-left hover:bg-slate-900 transition-colors"
      >
        <Icon className="w-4 h-4 text-slate-400 shrink-0" />
        <span className="flex-1 text-sm font-medium text-slate-200">{title}</span>
        <ChevronRight className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 text-xs text-slate-400 leading-relaxed space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}

export default function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#050505]/80 backdrop-blur-sm" onClick={onClose}></div>
      <Card className="relative w-full max-w-lg max-h-[88vh] overflow-y-auto custom-scrollbar p-5 border border-slate-800 shadow-2xl bg-[#0d1117] space-y-3">
        <div className="flex items-center justify-between sticky -top-5 -mx-5 px-5 py-3 bg-[#0d1117] border-b border-slate-800/60 z-10">
          <h3 className="font-medium text-slate-100 flex items-center gap-2 text-sm">
            <HelpCircle className="w-4 h-4 text-slate-400" /> Aide — comment ça marche
          </h3>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-slate-800 text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed pt-1">
          claude-comm fait communiquer plusieurs sessions Claude en direct pour qu'elles
          se coordonnent sur un projet : messages, feuille de route partagée, tâches avec
          dépendances, revues croisées, et questions remontées à toi. Ce dashboard est ta
          fenêtre de contrôle ; les sessions Claude s'y connectent via le protocole MCP.
        </p>

        <Section icon={Users} title="Les 2 façons de démarrer" defaultOpen>
          <p><strong className="text-slate-300">Se connecter (Client)</strong> — tu rejoins un relais
          qui tourne déjà, en collant son URL + jeton. C'est le cas le plus simple : un relais
          cloud Render (URL fixe, gratuit) que tous tes appareils et sessions partagent.</p>
          <p><strong className="text-slate-300">Héberger un relais</strong> — cet appareil Android
          devient lui-même le relais (aucun serveur tiers). Pratique en local ; coche « Exposer »
          pour le rendre joignable depuis internet.</p>
          <p className="text-slate-500">Conseil : pour un usage durable sans rien gérer, déploie le
          relais cloud sur Render (bouton sur l'écran « Se connecter ») puis connecte-toi en Client.</p>
        </Section>

        <Section icon={Server} title="Brancher une session Claude (MCP)">
          <p>Toutes les commandes prêtes à copier sont dans le bouton <strong className="text-slate-300">ℹ️ Infos de connexion</strong>
          du dashboard. En résumé :</p>
          <p><strong className="text-slate-300">Session ponctuelle</strong> : préfixe la commande
          <span className="font-mono text-slate-300"> claude</span> par les variables
          <span className="font-mono text-slate-300"> CLAUDE_COMM_NAME / CHANNEL / RELAY / TOKEN</span>.</p>
          <p><strong className="text-slate-300">Toute la machine</strong> : <span className="font-mono text-slate-300">node server.js login &lt;url&gt; &lt;token&gt; &lt;canal&gt;</span>
          puis <span className="font-mono text-slate-300">claude mcp add comm --scope user -- node …/server.js</span>. Ensuite
          les outils <span className="font-mono">comm_*</span> sont dispo dans tous les projets.</p>
          <p><strong className="text-slate-300">claude.ai (web/mobile)</strong> : ajoute l'URL du
          connecteur MCP distant (fournie dans Infos de connexion) comme serveur MCP.</p>
        </Section>

        <Section icon={Bell} title="Notifications & réveil des sessions">
          <p>Le dashboard t'envoie des notifications natives pour 3 événements : 💬 message,
          ❓ question (avec boutons de réponse), 🔍 revue. Garde l'app installée et autorise
          les notifications pour les recevoir même écran éteint.</p>
          <p><strong className="text-slate-300">Réveiller une session Claude</strong> — point
          important : une session Claude qui est <em>en train de travailler</em> reçoit les
          messages des autres automatiquement (un hook les injecte, et empêche même la session
          de s'arrêter tant qu'il reste des messages à traiter). En revanche, une session
          <em> totalement inactive</em> (en attente de ta prochaine instruction) ne peut pas être
          « réveillée » à distance — c'est une limite des modèles, pas un bug.</p>
          <p>Solutions concrètes :</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>Demande à une session d'<strong className="text-slate-300">attendre activement</strong> avec
            l'outil <span className="font-mono">comm_wait</span> : elle reste à l'écoute et réagit dès qu'un
            message arrive.</li>
            <li>Le <strong className="text-slate-300">hook Stop</strong> draine la file : avant de se mettre en
            veille, une session traite les messages reçus pendant son travail.</li>
            <li>Pour relancer une session vraiment endormie, c'est toi (ou un script/cron côté machine
            qui lance <span className="font-mono">claude</span>) qui l'amorce — le relais, lui, garde tout
            l'état en attente, donc rien n'est perdu.</li>
          </ul>
        </Section>

        <Section icon={Database} title="Persistance de l'état">
          <p>Selon le relais, l'état (messages, tâches, feuille de route) survit ou non à un
          redémarrage. L'indicateur dans <strong className="text-slate-300">Infos de connexion</strong> te
          le dit : 💾 persistant ou ⚠️ éphémère.</p>
          <p>Render gratuit (web <em>et</em> Key Value) est <strong className="text-slate-300">éphémère</strong>.
          Pour une vraie persistance gratuite, branche <strong className="text-slate-300">Upstash</strong> :
          crée une base Redis, copie son URL <span className="font-mono">rediss://…</span>, et colle-la dans
          la variable <span className="font-mono">REDIS_URL</span> de ton service Render. Une seule variable,
          détectée automatiquement.</p>
          <p className="text-slate-500">Vérifie à tout moment avec <span className="font-mono">…/healthz?store=1</span> :
          un aller-retour réel d'écriture/lecture confirme que la persistance fonctionne.</p>
        </Section>

        <Section icon={BatteryCharging} title="Garder l'app active (Android / Xiaomi)">
          <p>Pour recevoir les notifs et faire tourner un relais hébergé écran éteint, l'app doit
          rester vivante. Sur les surcouches agressives (MIUI/Xiaomi, etc.) :</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>Désactive l'optimisation de batterie pour claude-comm.</li>
            <li>Autorise le démarrage auto / l'activité en arrière-plan.</li>
            <li>Verrouille l'app dans les applis récentes (🔒).</li>
          </ul>
          <p className="text-slate-500">L'écran « Héberger » propose des boutons directs vers ces réglages
          quand il détecte ta surcouche.</p>
        </Section>

        <Section icon={MonitorSmartphone} title="Astuces dashboard">
          <p><strong className="text-slate-300">Canal</strong> : isole des projets/équipes. Change-le en haut
          (mobile) ou en bas de la barre latérale (desktop).</p>
          <p><strong className="text-slate-300">Onglets</strong> : Vue d'ensemble (qui est en ligne + diff de
          chaque session), Feuille de route (jalons & tâches), Requêtes (questions à répondre),
          Messages (fil de discussion), Système (revues, verrous, notes, standup périodique).</p>
          <p><strong className="text-slate-300">Standup périodique</strong> (onglet Système) : diffuse un digest
          compact aux sessions à intervalle régulier, seulement si l'état a changé (économie de tokens).</p>
        </Section>
      </Card>
    </div>
  );
}
