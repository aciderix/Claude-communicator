# claude-comm

**Coordination en direct entre plusieurs sessions Claude Code — sur une même
machine ou entre machines, de façon sécurisée.**

Deux (ou plus) sessions Claude qui travaillent en parallèle sur un même
projet peuvent se parler, se répartir le travail, consulter le diff et les
fichiers l'une de l'autre, et éviter de se marcher dessus — via un serveur
MCP **sans aucune dépendance** (Node ≥ 18).

```
            MODE FICHIER (même machine)            MODE RELAIS (multi-machines)
┌────────────────┐      ┌────────────────┐    ┌────────────────┐   ┌────────────────┐
│ Claude "alice" │      │  Claude "bob"  │    │ Claude "alice" │   │  Claude "bob"  │
│   server.js ◄──┼──┬───┼──► server.js   │    │   server.js ◄──┼─┐ │   server.js    │
└────────────────┘  │   └────────────────┘    └────────────────┘ │ └───────┬────────┘
              ~/.claude-comm/                        HTTPS + Bearer token  │
              ├ sessions/  (état live)                 ┌─────────▼─────────▼┐
              ├ inbox/     (messagerie)                │      relay.js      │
              ├ tasks.json (tâches)                    │  (machine C, VPS,  │
              ├ locks.json (verrous)                   │   conteneur...)    │
              └ notes.json (journal)                   └────────────────────┘
```

## Ce que ça permet

| Besoin | Outil |
|---|---|
| S'annoncer et voir qui travaille (et sur quelle machine) | `comm_join`, `comm_peers` |
| Envoyer un message / une question / une alerte | `comm_send` |
| Recevoir en direct (attente bloquante, long-poll) | `comm_inbox wait_seconds=60` |
| Publier son état (notifie les pairs si bloqué/fini) | `comm_status_set` |
| Consulter l'état de l'autre sans le déranger | `comm_status_get` |
| Demander activement un compte-rendu | `comm_send kind=status_request` |
| **Voir le diff git de l'autre en direct, même à distance** | `comm_diff peer=bob mode=full` |
| **Lire un fichier du worktree de l'autre** (lecture seule) | `comm_file peer=bob path=src/api.ts` |
| Se répartir les tâches (claim atomique) | `comm_task action=next` |
| Éviter d'éditer les mêmes fichiers | `comm_lock action=acquire` |
| **Journal partagé de décisions et conventions** | `comm_note action=add` |
| Attendre un événement (message, état, tâches, verrous) | `comm_wait` |

En mode relais, les demandes de diff et de fichier sont **auto-répondues par
l'instance du pair** (boucle de service en arrière-plan) : son modèle n'est
jamais interrompu. En bonus, chaque réponse d'outil signale les messages non
lus, et un hook optionnel injecte les messages entrants directement dans le
contexte — de vraies notifications, sans polling manuel.

## Installation

```bash
git clone https://github.com/aciderix/claude-communicator.git
```

C'est tout — aucun `npm install` nécessaire.

## Démarrage rapide — même machine (mode fichier)

**1. Déclarer le serveur MCP** dans le projet (`.mcp.json` à la racine) :

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

# Terminal 2 (autre worktree recommandé si vous éditez le même repo)
CLAUDE_COMM_NAME=bob claude
```

**3. Donner le protocole aux deux Claude** : collez le bloc de
[`PROTOCOL.md`](PROTOCOL.md) dans le prompt de chaque session (ou dans le
`CLAUDE.md` du projet).

## Démarrage rapide — multi-machines (mode relais)

**1. Sur une machine accessible aux deux (VPS, machine du bureau...)** :

```bash
node relay.js gen-token            # → garde ce secret
CLAUDE_COMM_RELAY_SECRET=<secret> node relay.js --host 0.0.0.0 --port 8787
```

**2. Sur chaque machine de travail**, même `.mcp.json` que ci-dessus, puis :

```bash
# Machine A
CLAUDE_COMM_NAME=alice \
CLAUDE_COMM_RELAY=https://relay.exemple.com:8787 \
CLAUDE_COMM_TOKEN=<secret> claude

# Machine B
CLAUDE_COMM_NAME=bob \
CLAUDE_COMM_RELAY=https://relay.exemple.com:8787 \
CLAUDE_COMM_TOKEN=<secret> claude
```

Tous les outils fonctionnent à l'identique, y compris `comm_diff` et
`comm_file` : l'instance du pair répond automatiquement à travers le relais.

### Sécurité du relais

Le relais est conçu pour être exposé publiquement, avec des défauts sûrs :

- **Jeton Bearer obligatoire** sur toutes les routes (sauf `/healthz`),
  comparé à temps constant (`crypto.timingSafeEqual`) — pas d'oracle de timing.
- **Bind sur `127.0.0.1` par défaut** : l'exposition réseau est un choix
  explicite (`--host 0.0.0.0`).
- **TLS natif** : `--tls-cert cert.pem --tls-key key.pem`, ou placez un
  reverse proxy HTTPS devant (Caddy, nginx). Un avertissement s'affiche si
  vous exposez sans TLS.
- **Aucune exécution de code côté relais** : il ne fait que stocker et router
  du JSON. Les commandes git tournent uniquement chez le pair, avec des
  arguments fixes.
- **Lecture de fichier confinée côté pair** : chemin résolu dans son
  répertoire de travail uniquement, 100 Ko max, binaires refusés.
- **Limites intégrées** : taille de corps (512 Ko), boîtes (500 messages),
  sessions/canaux plafonnés, rate-limit par IP (600 req/min).
- **Persistance optionnelle** (`--data ./relay-data`) : l'état survit aux
  redémarrages ; sans elle, tout est en mémoire.

> Modèle de confiance : toute personne possédant le jeton peut lire/écrire le
> canal et demander le diff/les fichiers du worktree des pairs. Donnez un
> jeton par équipe, faites-le tourner au besoin, et utilisez un canal
> (`CLAUDE_COMM_CHANNEL`) par projet.

## Configuration

| Variable / option | Défaut | Rôle |
|---|---|---|
| `CLAUDE_COMM_NAME` / `--name` | `claude-xxxx` | Nom de la session — **un par session** |
| `CLAUDE_COMM_CHANNEL` / `--channel` | `default` | Canal : isole des équipes/projets |
| `CLAUDE_COMM_HUB` / `--hub` | `~/.claude-comm` | Dossier du hub (mode fichier) |
| `CLAUDE_COMM_RELAY` / `--relay` | — | URL du relais → active le mode multi-machines |
| `CLAUDE_COMM_TOKEN` / `--token` | — | Jeton d'accès au relais |
| `CLAUDE_COMM_ROLE` / `--role` | — | Rôle affiché aux pairs |

Relais (`relay.js`) : `--port` (8787), `--host` (127.0.0.1),
`--secret`/`CLAUDE_COMM_RELAY_SECRET`, `--data <dir>`, `--tls-cert`,
`--tls-key`, sous-commande `gen-token`.

## Notifications "en direct" (hook optionnel mais recommandé)

Sans hook, une session découvre ses messages quand elle appelle un outil
`comm_*` (compteur de non-lus dans chaque réponse). Avec le hook, les
messages entrants sont injectés automatiquement dans son contexte. Dans
`.claude/settings.json` du projet (voir
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

Le hook fonctionne dans les deux modes (il utilise les mêmes variables
d'environnement) et fait aussi office de heartbeat.

## Supervision humaine

```bash
node server.js status                 # mode fichier
CLAUDE_COMM_RELAY=... CLAUDE_COMM_TOKEN=... node server.js status   # via relais
```

Affiche sessions (🟢/⚪), tâches, verrous et messages en attente du canal.

## Les outils en détail

- **`comm_join`** — s'annonce sur le canal (rôle, tâche de départ), liste les
  pairs présents, notifie les autres de l'arrivée.
- **`comm_peers`** — qui est là : état, tâche, progression, machine, branche
  git, dernière activité.
- **`comm_send`** — message direct ou broadcast (`to="*"`). Types : `message`,
  `question`, `status_request`, `diff_request`, `alert`, `task`. Réponse à un
  message via `reply_to=<id>`.
- **`comm_inbox`** — relève les messages ; `wait_seconds=N` bloque jusqu'à
  l'arrivée d'un message. Signale ceux qui attendent une réponse.
- **`comm_status_set`** — publie l'état live (`working`, `blocked`, `done`,
  `reviewing`, `idle`) + tâche + progression. `blocked`/`done` notifient
  automatiquement.
- **`comm_status_get`** — lit l'état publié d'un pair, instantané.
- **`comm_diff`** — diff git du worktree d'un pair sans le déranger :
  status, diff (stat/files/full), fichiers non suivis, filtrable par chemin.
  Multi-machines via le relais (auto-répondu par son instance).
- **`comm_file`** — lit un fichier ou liste un dossier du worktree d'un pair
  (lecture seule, confiné, 100 Ko max).
- **`comm_task`** — tableau partagé : `add`, `list`, `next` (claim atomique),
  `claim`, `update`, `done`, `release`. Chaque changement notifie les pairs.
- **`comm_lock`** — verrous coopératifs sur fichiers/dossiers (chemins
  parent/enfant en conflit). `acquire` / `release` / `list`.
- **`comm_note`** — journal partagé de décisions/conventions, taggable,
  persistant pour toutes les sessions du canal.
- **`comm_wait`** — attente bloquante : `message`, `peer_status`, `tasks`,
  `locks` (long-poll efficace en mode relais, timeout max 300 s).

## Limites connues

- Les **verrous sont coopératifs** : ils n'empêchent pas physiquement une
  édition, ils s'appuient sur la discipline du protocole (`PROTOCOL.md`).
- En mode fichier, `comm_diff`/`comm_file` exigent que le répertoire du pair
  soit accessible localement (le mode relais lève cette limite).
- Le relais fait confiance à tout porteur du jeton : un jeton = une équipe.

## Tests

```bash
npm test   # 28 assertions en mode fichier + 18 en mode relais
```
