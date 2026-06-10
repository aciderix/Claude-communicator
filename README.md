# claude-comm

**Coordination en direct entre plusieurs sessions Claude Code.**

Deux (ou plus) sessions Claude qui travaillent en parallèle sur un même
projet peuvent se parler, se répartir le travail et éviter de se marcher
dessus — via un serveur MCP sans aucune dépendance (Node ≥ 18, un seul
fichier).

```
┌─────────────────┐                       ┌─────────────────┐
│  Claude "alice" │                       │   Claude "bob"  │
│  (terminal 1)   │                       │  (terminal 2)   │
│       │         │                       │       │         │
│  server.js ◄────┼──── hub partagé ──────┼────► server.js  │
└─────────────────┘   ~/.claude-comm/      └─────────────────┘
                      ├ sessions/   (état live de chacun)
                      ├ inbox/      (messagerie)
                      ├ tasks.json  (tableau de tâches partagé)
                      └ locks/      (verrous de fichiers)
```

## Ce que ça permet

| Besoin | Outil |
|---|---|
| S'annoncer et voir qui travaille | `comm_join`, `comm_peers` |
| Envoyer un message / une question / une alerte | `comm_send` |
| Recevoir en direct (attente bloquante possible) | `comm_inbox wait_seconds=60` |
| Publier son état (notifie les pairs si bloqué/fini) | `comm_status_set` |
| Consulter l'état de l'autre sans le déranger | `comm_status_get` |
| Demander activement un compte-rendu | `comm_send kind=status_request` |
| **Voir le diff git de l'autre en direct** | `comm_diff peer=bob mode=full` |
| Se répartir les tâches (claim atomique) | `comm_task action=next` |
| Éviter d'éditer les mêmes fichiers | `comm_lock action=acquire` |
| Attendre un événement (message, état, tâches, verrous) | `comm_wait` |

En bonus : chaque réponse d'outil signale les messages non lus
(`📬 2 message(s) non lu(s)`), et un **hook optionnel** injecte les
messages entrants directement dans le contexte de la session — de vraies
notifications, sans polling manuel.

## Installation

```bash
git clone https://github.com/aciderix/claude-communicator.git
```

C'est tout — aucun `npm install` nécessaire.

## Démarrage rapide (deux terminaux, même projet)

**1. Déclarer le serveur MCP** dans le projet sur lequel vous travaillez
(`.mcp.json` à la racine, ou `claude mcp add`) :

```json
{
  "mcpServers": {
    "comm": {
      "command": "node",
      "args": ["/chemin/vers/claude-communicator/server.js"]
    }
  }
}
```

**2. Lancer chaque session avec un nom différent** :

```bash
# Terminal 1
CLAUDE_COMM_NAME=alice claude

# Terminal 2 (autre worktree ou autre dossier si vous éditez en parallèle)
CLAUDE_COMM_NAME=bob claude
```

**3. Donner le protocole aux deux Claude** : collez le bloc de
[`PROTOCOL.md`](PROTOCOL.md) dans le prompt de chaque session (ou dans le
`CLAUDE.md` du projet). Il leur explique quand s'annoncer, publier leur
état, relever leur boîte, verrouiller, et se répartir les tâches.

Exemple de premier message :

> Tu es "alice". Ton binôme "bob" tourne dans un autre terminal.
> Coordonnez-vous via les outils comm_* (voir protocole ci-dessous).
> Mission : migrer l'app vers TypeScript. Découpe le travail en tâches
> avec comm_task, prends-en une, et avancez en parallèle.

## Configuration

| Variable / option | Défaut | Rôle |
|---|---|---|
| `CLAUDE_COMM_NAME` / `--name` | `claude-xxxx` (aléatoire) | Nom de la session — **à définir, un par terminal** |
| `CLAUDE_COMM_CHANNEL` / `--channel` | `default` | Canal : isole des équipes différentes |
| `CLAUDE_COMM_HUB` / `--hub` | `~/.claude-comm` | Dossier partagé du hub |
| `CLAUDE_COMM_ROLE` / `--role` | — | Rôle affiché aux pairs |

## Notifications "en direct" (hook optionnel mais recommandé)

Sans hook, une session découvre ses messages quand elle appelle un outil
`comm_*` (chaque réponse affiche le compteur de non-lus). Avec le hook,
les messages entrants sont injectés automatiquement dans son contexte à
chaque prompt utilisateur et après chaque outil :

Dans `.claude/settings.json` du projet (voir
[`examples/settings.hooks.json`](examples/settings.hooks.json)) :

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /chemin/vers/claude-communicator/hooks/comm-hook.js" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node /chemin/vers/claude-communicator/hooks/comm-hook.js" }] }
    ]
  }
}
```

Le hook utilise `CLAUDE_COMM_NAME` pour savoir quelle boîte relever, et
fait aussi office de heartbeat (les pairs voient la session « vivante »
même quand elle n'appelle pas d'outil comm).

## Supervision humaine

Pour voir d'un coup d'œil l'état du canal (sessions, tâches, verrous,
messages en attente) :

```bash
node server.js status
# ou avec un canal précis :
CLAUDE_COMM_CHANNEL=mon-equipe node server.js status
```

## Les outils en détail

- **`comm_join`** — s'annonce sur le canal (rôle, tâche de départ), liste
  les pairs présents, notifie les autres de l'arrivée.
- **`comm_peers`** — qui est là, état, tâche, progression, branche git,
  dernière activité (🟢 actif / ⚪ silencieux).
- **`comm_send`** — message direct ou broadcast (`to="*"`). Types :
  `message`, `question`, `status_request`, `diff_request`, `alert`,
  `task`. Réponse à un message via `reply_to=<id>`.
- **`comm_inbox`** — relève les messages ; `wait_seconds=N` bloque
  jusqu'à l'arrivée d'un message (synchronisation en direct). Signale
  les messages qui attendent une réponse.
- **`comm_status_set`** — publie l'état live (`working`, `blocked`,
  `done`, `reviewing`, `idle`) + tâche + progression. `blocked`/`done`
  notifient automatiquement les pairs.
- **`comm_status_get`** — lit l'état publié d'un pair, instantané.
- **`comm_diff`** — lit le diff git du worktree d'un pair **sans le
  déranger** : `git status`, diff (stat/files/full), fichiers non
  suivis, filtrable par chemin.
- **`comm_task`** — tableau partagé : `add`, `list`, `next` (claim
  atomique de la prochaine tâche libre), `claim`, `update`, `done`,
  `release`. Chaque changement notifie les pairs.
- **`comm_lock`** — verrous coopératifs sur fichiers/dossiers (un chemin
  parent/enfant compte comme conflit). `acquire` / `release` / `list`.
- **`comm_wait`** — attente bloquante d'un événement : `message`,
  `peer_status`, `tasks`, `locks` (timeout max 300 s).

## Limites connues

- Les sessions doivent partager un **système de fichiers** (même machine,
  ou hub sur un montage partagé). Pas de relais réseau en v1.
- `comm_diff` lit le worktree du pair directement : il faut que son
  répertoire soit accessible. Pour éditer en parallèle le même repo,
  utilisez deux `git worktree` (recommandé de toute façon).
- Les verrous sont **coopératifs** : ils n'empêchent pas physiquement une
  édition, ils s'appuient sur la discipline du protocole.

## Tests

```bash
npm test   # test de fumée : 2 serveurs, messagerie, tâches, verrous, wait, diff
```
