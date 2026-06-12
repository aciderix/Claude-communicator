import { AppState } from './types';

export const MOCK_STATE: AppState = {
  version: 42,
  sessions: [
    {
      name: "frontend-agent",
      live: true,
      role: "React Developer",
      state: "working",
      last_model_seen: new Date().toISOString(),
      host: "Cloud-Container-A",
      branch: "feature/modern-ui",
      head: "a1b2c3d",
      last_seen: new Date().toISOString(),
      task: "Implémentation du tableau de bord",
      progress: "85%"
    },
    {
      name: "reviewer-bot",
      live: true,
      role: "Code Reviewer",
      state: "idle",
      last_model_seen: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      host: "Local-MacBook",
      last_seen: new Date().toISOString(),
    },
    {
      name: "database-agent",
      live: true,
      role: "Backend Architect",
      state: "reviewing",
      last_model_seen: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      host: "Linux-Server-2",
      last_seen: new Date().toISOString(),
      task: "Vérification des règles Firebase",
    },
    {
      name: "legacy-worker",
      live: false,
      role: "Maintenance",
      state: "offline",
      host: "Desktop-WS",
      last_seen: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      detail: "Déconnecté inopinément (Timeout)"
    }
  ],
  plan: {
    goal: "Refonte de l'interface utilisateur de Claude-Comm",
    milestones: [
      { id: "M1", title: "Maquettes & Design System", status: "done" },
      { id: "M2", title: "Intégration React & Tailwind", status: "active", detail: "En cours sur le tableau de bord" },
      { id: "M3", title: "Tests et Déploiement", status: "todo" }
    ]
  },
  tasks: {
    tasks: [
      { id: "T-101", title: "Configurer Vite & Tailwind", status: "done", milestone: "M1" },
      { id: "T-102", title: "Créer les composants UI (Card, Button)", status: "done", milestone: "M1", owner: "frontend-agent" },
      { id: "T-103", title: "Assembler le Dashboard", status: "in_progress", milestone: "M2", owner: "frontend-agent" },
      { id: "T-104", title: "Revue du code frontal", status: "blocked", milestone: "M2", deps: ["T-103"], notes: ["En attente du PR final"] },
      { id: "T-105", title: "Rédiger la documentation", status: "todo", milestone: "M3" }
    ]
  },
  user: {
    msgs: {
      items: [
        {
          id: "m-1",
          to: "*",
          ts: new Date(Date.now() - 3600 * 1000).toISOString(),
          body: "Bonjour à tous, on se concentre sur l'UI aujourd'hui. Laissez le backend de côté.",
          replies: [
            { by: "database-agent", ts: new Date(Date.now() - 3500 * 1000).toISOString(), body: "Reçu. Je me mets en pause sur la base de données." }
          ]
        },
        {
          id: "m-2",
          to: "frontend-agent",
          ts: new Date(Date.now() - 30 * 1000).toISOString(),
          body: "Peux-tu vérifier que les couleurs des badges correspondent bien aux statuts ?",
          status: "claimed",
          claimed_by: "frontend-agent",
          replies: []
        }
      ]
    },
    questions: {
      items: [
        {
          id: "q-1",
          from: "frontend-agent",
          status: "open",
          ts: new Date(Date.now() - 1200 * 1000).toISOString(),
          text: "Pour les bordures des cartes, préférez-vous un bleu subtil (slate-800) ou quelque chose de plus accentué ?",
          options: ["Subtil (Slate 800)", "Accentué (Bleu 500)"],
          context: "Je configure le fichier index.css pour les thèmes."
        },
        {
          id: "q-2",
          from: "reviewer-bot",
          status: "answered",
          ts: new Date(Date.now() - 7200 * 1000).toISOString(),
          text: "Pouvons-nous utiliser lucide-react pour les icônes ?",
          answered_at: new Date(Date.now() - 7100 * 1000).toISOString(),
          answer: "Oui, c'est ce qui est défini dans les prérequis."
        }
      ]
    }
  },
  reviews: {
    items: [
      { id: "REV-04", status: "pending", title: "UI Components Refactor", from: "frontend-agent", to: "reviewer-bot" },
      { id: "REV-03", status: "approved", title: "API Client Setup", from: "database-agent", to: "*" },
      { id: "REV-02", status: "changes_requested", title: "Navigation Layout", from: "frontend-agent", to: "reviewer-bot" }
    ]
  },
  locks: [
    { path: "/src/index.css", owner: "frontend-agent", reason: "Mise à jour de la charte graphique" },
    { path: "/src/components/UI.tsx", owner: "frontend-agent" }
  ],
  notes_tail: [
    { by: "reviewer-bot", text: "Les performances d'affichage sont bonnes avec la nouvelle structure en grille." },
    { by: "database-agent", text: "Veille passive en cours." }
  ],
  config: { standup_minutes: 15 }
};
