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
| **Feuille de route partagée que tous complètent** (cap + jalons) | `comm_plan` |
| Se répartir les tâches (claim atomique, rattachées aux jalons) | `comm_task action=next` |
| **Dépendances entre tâches** (T4 attend que T2 soit done) | `comm_task add deps=["T2"]` |
| Assigner une tâche à un pair (le lead bosse aussi) | `comm_task action=assign` |
| **Répondre à l'utilisateur sans doublon** (claim anti-gaspillage) | `comm_user action=claim/reply` |
| **Poser une question à l'utilisateur** (réponse diffusée à tous) | `comm_user action=ask` |
| Savoir si le pair est **hors d'usage** (limite 5 h/hebdo) ou **compacté** | `comm_peers` + hooks |
| **Standup périodique optionnel** (digest seulement si changement) | CLI `standup 30` / dashboard |
| **Revue croisée avant merge** (diff joint automatiquement) | `comm_review` |
| **Vue d'ensemble agrégée** (plan, sessions, tâches, revues...) | `comm_overview` |
| Éviter d'éditer les mêmes fichiers | `comm_lock action=acquire` |
| **Journal partagé de décisions et conventions** | `comm_note action=add` |
| Attendre un événement (message, état, tâches, plan, revues, verrous) | `comm_wait` |
| **L'humain participe au canal** (superviser, ordonner, répondre) | CLI `status` / `send` / `inbox` |

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

## Démarrage en UNE commande (recommandé)

```bash
node up.js --project /chemin/de/ton/projet
```

Autonome (aucun service tiers) : lance le relais sur le LAN avec
persistance, écrit le `.mcp.json` du projet (sans secret → committable),
et affiche tout ce qu'il faut :

- **📱 mobile** : une URL locale (`http://192.168.x.x:8787`) + un **code
  d'appairage à 6 chiffres** à taper dans le dashboard (pas de jeton de
  43 caractères à recopier ; code valable 15 min, 20 essais max, rotation
  automatique) ;
- **💻 sessions** : la commande exacte à coller dans chaque terminal
  (`CLAUDE_COMM_NAME=alice ... claude`) ;
- **🧑 humain** : les commandes CLI prêtes à l'emploi.

Options : `--sessions alice,bob,charlie` (noms), `--channel equipe`,
`--port`, `--hooks` (branche les hooks de notification/compaction dans
`.claude/settings.json`, en préservant l'existant avec sauvegarde
`.bak`), et `--tunnel cloudflared|ngrok` pour ajouter une URL publique
quand tu veux accéder de l'extérieur (le tunnel est le seul élément
tiers, et il est optionnel — cloudflared est téléchargé automatiquement
sous Linux s'il manque). Ctrl+C arrête tout.

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
d'environnement) et fait aussi office de heartbeat « modèle actif ».

Branchez aussi `Stop`, `PreCompact`, `SessionStart` et `SessionEnd` sur le
même script (l'exemple complet est dans
[`examples/settings.hooks.json`](examples/settings.hooks.json)) pour
activer la détection d'indisponibilité et de compaction décrite plus haut.

## Dashboard web (mode relais)

Le relais sert un dashboard sur `http(s)://<relais>/` : ouvrez-le dans un
navigateur, saisissez le jeton (gardé en localStorage) et le canal.

- **Suivi en direct** (long-poll) : sessions avec état/branche/machine,
  badges « 🟡 modèle silencieux » et « ♻️ compacté », feuille de route avec
  barres de progression, tâches (avec dépendances), revues, verrous, notes.
- **Explorer le travail** : bouton « voir diff » par session (stat/complet),
  répondu automatiquement par l'instance du pair.
- **Converser avec les sessions** : envoi ciblé (une session) ou à toutes.
  Pour un message « à tous », la première session qui répond pose un *claim*
  visible dans le fil (« ✍️ alice rédige… ») ; l'autre est notifiée et ne
  rédige pas en double — elle ne complète que si la réponse est incorrecte.
- **Répondre aux questions des IA** : quand une session pose une question
  (`comm_user action=ask`, p.ex. faute de consensus entre elles), elle
  apparaît dans le dashboard avec ses options en boutons ; votre réponse est
  diffusée à toutes les sessions.
- **Historique persistant** : conversation et questions vivent côté relais
  (et survivent aux redémarrages avec `--data`) — fermez le navigateur,
  rouvrez, tout est là.
- **Standup périodique** : réglable depuis l'en-tête (minutes, 0 = off).

Astuce : même sur une seule machine, lancer le relais en local
(`node relay.js`) donne accès au dashboard.

## Application de bureau (zéro ligne de commande)

Une vraie app installable — double-clic, pas de terminal, pas de
navigateur :

- **Windows** `.exe` · **macOS** `.dmg` · **Linux** `.AppImage`, construits
  automatiquement par GitHub Actions (onglet *Actions* → `build-app` →
  *Run workflow*, ou en poussant un tag `v*` : les installeurs sont
  attachés à la release).
- Au premier lancement, l'app demande un choix (modifiable ensuite dans
  *Paramètres*) :
  - **🏠 Héberger ici** — ce PC devient le serveur : le relais embarqué
    démarre tout seul (secret généré et conservé, état persistant,
    appairage mobile), avec une case « Exposer sur Internet » (tunnel
    intégré) pour y accéder depuis l'extérieur. Le menu « Connexion
    d'autres appareils » affiche l'adresse, le code d'appairage et la
    commande pour les sessions d'autres machines.
  - **🔌 Se connecter** — à un relais existant (cloud, autre PC,
    téléphone) : URL + jeton, vérifiés avant enregistrement.
- L'app n'est qu'une porte d'entrée de plus : le CLI, le relais cloud,
  Termux et le dashboard navigateur continuent de fonctionner en
  parallèle sur le même canal.

Développement local : `cd app && npm install && npm start`.

## Application mobile native (Android, sans Termux ni PWA)

Une vraie app Android (`.apk`, construite par le même workflow
GitHub Actions) qui fait **tout depuis l'app**, de la mise en route au
dashboard :

- **🏠 Héberger sur ce téléphone** : le relais tourne *dans* l'app grâce à
  un moteur Node embarqué (nodejs-mobile via Capacitor) — plus besoin de
  Termux. Secret généré et conservé, état persistant, exposition Internet
  en une case à cocher (tunnel intégré), et l'app affiche l'adresse WiFi +
  le jeton pour connecter les PC.
- **🔌 Se connecter** : à un relais existant (cloud, app de bureau, autre
  téléphone).
- Le dashboard s'affiche ensuite directement dans l'app (pas de
  navigateur). Le dossier `mobile/www/` est volontairement minimal : un
  front React peut le remplacer tel quel, toute la plomberie native
  (Node embarqué, canal de communication, config) est conservée.

Build : onglet *Actions* → `build-app` → l'APK `claude-comm-android` est
dans les artefacts (signature debug : installation par sideload —
« sources inconnues »).

## Zéro manip au quotidien (relais hébergé)

Les commandes (tunnels, exports, `up.js`…) n'existent que si vous hébergez
le relais sur un appareil personnel. Pour ne **plus jamais taper de
commande**, déplacez le relais vers un hébergeur une bonne fois pour
toutes :

**1. Hébergez le relais (5 min, une seule fois)**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/aciderix/claude-communicator)

Un clic → URL HTTPS stable (`https://votre-relais.onrender.com`), secret
généré automatiquement (visible dans les variables d'environnement Render).
Alternative : `Dockerfile` fourni pour n'importe quel hébergeur/VPS/NAS.
Plus de tunnel, plus de Termux, plus d'URL qui change.

**2. Sur chaque machine de travail (une seule fois)**

```bash
node server.js login https://votre-relais.onrender.com <jeton>
claude mcp add comm --scope user -- node /chemin/claude-communicator/server.js
```

La connexion est mémorisée (`~/.claude-comm/credentials.json`, mode 600) et
les outils comm_* sont disponibles dans **tous** vos projets.

**3. Sur le téléphone (une seule fois)**

Ouvrez l'URL du relais → code d'appairage ou jeton → menu ⋮ →
*Installer l'application* : le dashboard devient une app (PWA) avec icône
et plein écran.

**4. Au quotidien : rien.**

Vous lancez `claude` (les noms de session sont auto-générés si absents),
les IA se coordonnent seules, et l'app sur votre téléphone montre tout en
direct, où que vous soyez.

> Plan free Render : l'instance s'endort après inactivité et l'état est en
> mémoire — suffisant pour coordonner des sessions actives. Pour un état
> persistant (historique long, feuille de route au long cours) : plan
> starter + disque (voir `render.yaml`), ou n'importe quel VPS avec
> `--data`.

## Termux (Android) : héberger le relais sur un téléphone

Testé en conditions réelles — le relais et le dashboard tournent très bien
dans [Termux](https://termux.dev) :

```bash
pkg install nodejs git openssh
git clone https://github.com/aciderix/claude-communicator.git
cd claude-communicator
termux-wake-lock          # empêche Android de tuer le relais écran éteint
node up.js --tunnel pinggy
```

Particularités Android :

- **Tunnel : utilisez `--tunnel pinggy`** (SSH sur le port 443). Le binaire
  officiel cloudflared linux-arm64 ne fonctionne pas sur certains
  appareils Android (arrêt immédiat, code 1).
- Si `password:` s'affiche pour pinggy, **appuyez simplement sur Entrée**
  (mode anonyme). URL gratuite valable ~60 min ; relancez `up.js` pour en
  obtenir une nouvelle (le relais et son état sont réutilisés tels quels).
- Le dashboard local du téléphone est sur `http://127.0.0.1:8787`.
- **Démarrage automatique au boot du téléphone** : installez l'app
  Termux:Boot (F-Droid) puis copiez
  [`termux/boot-claude-comm.sh`](termux/boot-claude-comm.sh) dans
  `~/.termux/boot/` — le relais et son tunnel se lancent seuls à chaque
  redémarrage (journal dans `~/.claude-comm/up.log`).

## Disponibilité du pair : limite d'usage, compaction

Avec les hooks branchés (voir plus bas), chaque session sait ce qui arrive
à l'autre :

- **Hors d'usage / silencieux** : le serveur distingue la vie du processus
  (`last_seen`) de l'activité du modèle (`last_model_seen`, alimenté par les
  appels d'outils et les hooks). Si la session est connectée mais que le
  modèle n'a rien fait depuis 10 min, `comm_peers` et le dashboard
  l'affichent 🟡 « modèle inactif — probablement hors d'usage (limite
  5 h/hebdo) ou en attente d'input », avec la consigne d'avancer sans lui.
- **Compaction** : le hook `PreCompact` prévient les pairs avant la
  compaction ; `SessionStart(source=compact)` la signale après coup ET
  réinjecte à la session compactée la consigne de se resynchroniser
  (`comm_overview` + `comm_note list`). Badge ♻️ dans `comm_peers` et le
  dashboard pendant 30 min.
- **Départ** : `SessionEnd` marque la session offline et prévient les pairs
  (« réassigne ses tâches si nécessaire »).

## Économie de tokens

L'outil est conçu pour coûter le moins possible en contexte :

- **Claim de réponse utilisateur** : une seule session rédige, l'autre est
  notifiée et ne dépense des tokens que si une correction s'impose.
- **Standup uniquement sur changement** : le digest (généré sans LLM) n'est
  envoyé que si l'état a évolué depuis le précédent ; désactivé par défaut.
- **Long-poll partout** : `comm_inbox wait` et `comm_wait` dorment côté
  serveur au lieu de boucler en appels d'outils.
- **Diff/fichiers auto-répondus** : consulter le travail du pair ne consomme
  aucun token chez lui.
- **Tailles plafonnées** : messages, diffs (30 Ko), fichiers (100 Ko),
  notes, et notifications compactes (sujets courts, corps tronqués).
- `comm_overview` agrège tout en un appel au lieu de cinq.

## L'humain dans la boucle (CLI)

Le propriétaire du projet peut superviser **et participer** au canal sans
session Claude (fonctionne dans les deux modes ; via relais, ajoutez
`CLAUDE_COMM_RELAY` et `CLAUDE_COMM_TOKEN`) :

```bash
node server.js status            # feuille de route, sessions, tâches, revues, verrous

CLAUDE_COMM_NAME=patron node server.js send "*" "Priorité au bugfix #42"
CLAUDE_COMM_NAME=patron node server.js send alice "Où en es-tu ?"
CLAUDE_COMM_NAME=patron node server.js inbox     # lire les réponses
node server.js questions                          # questions posées par les IA
node server.js answer Q1 "Non, via PR uniquement" # répondre (diffusé à tous)
node server.js standup 30                         # standup périodique (0 = off)
```

Les sessions Claude voient l'humain comme un pair et peuvent lui répondre
avec `comm_send to=patron`.

## Orchestration : feuille de route et lead qui bosse

La **feuille de route partagée** (`comm_plan`) porte le cap de la mission
et des jalons (M1, M2...) que *toutes* les sessions peuvent compléter et
faire évoluer en cours de route. Les tâches s'y rattachent
(`comm_task add milestone=M2`) et la progression par jalon est agrégée
automatiquement, visible d'un coup avec `comm_overview`.

Un « lead » n'est qu'un rôle, pas un statut : il peut assigner des tâches
(`comm_task action=assign id=T3 to=bob` — le `next` de bob prendra ses
tâches assignées en priorité) **tout en prenant lui-même des tâches en
parallèle**. Avant de merger, chacun demande une relecture croisée avec
`comm_review` (le diff stat est joint automatiquement à la demande).
Les recettes complètes sont dans [`PROTOCOL.md`](PROTOCOL.md).

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
- **`comm_plan`** — feuille de route partagée : cap (`goal`) + jalons
  (`add`/`update`/`done`/`list`), complétable par toutes les sessions,
  progression par jalon calculée depuis les tâches rattachées.
- **`comm_task`** — tableau partagé : `add` (options `milestone` et `deps` —
  dépendances respectées par `next`/`claim`, tâches débloquées signalées au
  `done`), `list`, `next` (claim atomique, tâches assignées en priorité),
  `claim`, `assign` (confier à un pair), `update`, `done`, `release`.
  Chaque changement notifie les pairs.
- **`comm_user`** — interactions avec l'humain : `claim` (verrou de réponse
  anti-gaspillage sur les messages « à tous »), `reply` (publier vers le
  dashboard), `ask` (question à l'utilisateur, avec options ; réponse
  diffusée à tous), `list`.
- **`comm_review`** — revue croisée : `request` (diff stat joint
  automatiquement), `approve`/`changes` (réservés au relecteur désigné),
  `close` (réservé au demandeur), `list`.
- **`comm_overview`** — tout l'état du canal en un appel : feuille de
  route, sessions, tâches ouvertes, revues en attente, verrous, notes.
- **`comm_lock`** — verrous coopératifs sur fichiers/dossiers (chemins
  parent/enfant en conflit). `acquire` / `release` / `list`.
- **`comm_note`** — journal partagé de décisions/conventions, taggable,
  persistant pour toutes les sessions du canal.
- **`comm_wait`** — attente bloquante : `message`, `peer_status`, `tasks`,
  `plan`, `reviews`, `locks` (long-poll efficace en mode relais, timeout
  max 300 s).

## Limites connues

- Les **verrous sont coopératifs** : ils n'empêchent pas physiquement une
  édition, ils s'appuient sur la discipline du protocole (`PROTOCOL.md`).
- En mode fichier, `comm_diff`/`comm_file` exigent que le répertoire du pair
  soit accessible localement (le mode relais lève cette limite).
- Le relais fait confiance à tout porteur du jeton : un jeton = une équipe.

## Tests

```bash
npm test   # 59 assertions en mode fichier + 32 en mode relais
```
