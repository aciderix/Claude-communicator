# Protocole de collaboration entre sessions Claude

Colle ce bloc dans le prompt de **chaque** session Claude (ou dans le
`CLAUDE.md` du projet) pour que les deux agents se coordonnent proprement
via les outils `comm_*`.

---

## Bloc à coller dans chaque session

```
Tu travailles en binôme avec une autre session Claude sur ce projet.
Vous vous coordonnez via les outils MCP comm_* (serveur "comm").

Règles de coordination :

1. DÉMARRAGE — Appelle comm_join en annonçant ton rôle et ta mission.
   Regarde comm_peers pour voir qui est là et sur quoi il travaille.

2. ÉTAT LIVE — Publie ton état avec comm_status_set à chaque changement :
   début de tâche (state=working), blocage (state=blocked), fin (state=done).
   Mets une progression lisible (ex: "3/5 fichiers migrés").

3. BOÎTE AUX LETTRES — Relève comm_inbox :
   - avant de commencer une nouvelle tâche,
   - après chaque tâche terminée,
   - dès qu'un résultat d'outil signale "📬 message(s) non lu(s)".
   Réponds TOUJOURS aux messages kind=question / status_request /
   diff_request via comm_send avec reply_to=<id>.

4. FEUILLE DE ROUTE — La vision partagée vit dans comm_plan :
   - le cap de la mission (action=goal) et les jalons M1, M2...
   - Tout le monde peut la compléter et la faire évoluer : si tu
     découvres un jalon manquant, ajoute-le et notifie pourquoi.
   - Rattache les tâches aux jalons (comm_task add milestone=M2) :
     la progression par jalon est calculée automatiquement.
   - Consulte comm_overview en début de session et entre deux tâches.

5. RÉPARTITION — Le travail passe par le tableau partagé comm_task :
   - décomposez d'abord le travail en tâches (action=add),
   - prends la prochaine tâche avec action=next (claim atomique ;
     tes tâches assignées passent en premier),
   - tu peux confier une tâche précise à un pair (action=assign),
     tout en continuant TOI-MÊME à travailler : un "lead" n'est pas
     un spectateur, il prend aussi des tâches,
   - marque action=done avec une note de résultat,
   - ne travaille JAMAIS sur une tâche prise par l'autre.

6. ANTI-COLLISION — Avant d'éditer des fichiers que l'autre pourrait
   toucher, verrouille-les : comm_lock action=acquire paths=[...].
   Libère dès que tu as fini. Si un verrou est refusé, travaille sur
   autre chose ou attends avec comm_wait until=locks.

7. VISIBILITÉ — Pour savoir où en est l'autre sans le déranger :
   comm_status_get (état publié), comm_diff (son diff git en direct) et
   comm_file (sa version d'un fichier, en lecture seule).
   Pour un compte-rendu actif : comm_send kind=status_request, puis
   comm_inbox wait_seconds=60.

8. SYNCHRONISATION — Si tu dépends du travail de l'autre, ne tourne pas
   en boucle : utilise comm_wait (until=message / peer_status / tasks /
   plan / reviews / locks).

9. DÉCISIONS — Toute décision qui engage les deux (interface commune,
   convention de nommage, choix de lib, piège découvert) va dans le
   journal partagé : comm_note action=add tags=["decision"]. Consulte
   comm_note action=list avant de trancher un point d'architecture.

10. REVUE — Avant de merger un changement significatif, demande une
    relecture croisée : comm_review action=request to=<pair> (ton diff
    est joint automatiquement). Le relecteur répond approve ou changes ;
    pendant ce temps, prends une autre tâche. Clos la revue après merge.

11. FIN — Quand le tableau est vide et ton travail poussé :
    comm_status_set state=done, et envoie un résumé final à l'autre.
```

---

## Scénarios types

### Demander l'état de l'autre (« demande d'état »)

```
comm_send  to=bob kind=status_request body="Où en es-tu sur l'API ?"
comm_inbox wait_seconds=60        ← attend la réponse en direct
```

Ou sans le déranger : `comm_status_get peer=bob` (instantané, lit son état publié).

### Demander / consulter le diff de l'autre (« demande de diff »)

```
comm_diff peer=bob mode=stat          ← résumé direct de son worktree
comm_diff peer=bob mode=full path=src ← diff complet d'un dossier
```

Ou en lui demandant un résumé commenté : `comm_send to=bob kind=diff_request body="Résume tes changements sur src/auth"`.

En mode relais (multi-machines), `comm_diff` et `comm_file` sont répondus
automatiquement par l'instance du pair — son modèle n'est pas interrompu.

### Voir la version d'un fichier du pair

```
comm_file peer=bob path=src/types/api.ts   ← avant de coder contre son interface
```

### Paralléliser un gros chantier

```
Session A : comm_task action=add title="Migrer module users"
            comm_task action=add title="Migrer module billing"
            comm_task action=add title="Mettre à jour les tests"
A et B    : comm_task action=next   ← chacun prend une tâche, atomique
            ... travail ...
            comm_task action=done id=T1 note="poussé sur ma branche"
            comm_task action=next   ← enchaîne
```

### Point de rendez-vous

```
Session A : comm_send to=bob body="Je pousse la base commune, attends mon signal avant de rebaser."
Session B : comm_wait until=message timeout_seconds=300
```

### Orchestration : un lead qui bosse aussi

Le « lead » n'est qu'un rôle (`comm_join role="lead"`), pas un statut à
part : il construit la feuille de route, assigne ce qui doit l'être, et
prend lui-même des tâches comme tout le monde.

```
Lead    : comm_plan action=goal text="Sortir la v2 de l'API"
          comm_plan action=add title="Endpoints CRUD"      → M1
          comm_plan action=add title="Auth + permissions"  → M2
          comm_task action=add title="users" milestone=M1
          comm_task action=add title="billing" milestone=M1
          comm_task action=add title="JWT" milestone=M2
          comm_task action=assign id=T3 to=bob             ← spécialité de bob
          comm_task action=next                            ← le lead bosse aussi
Workers : comm_task action=next                            ← assignées d'abord, puis libres
Tous    : comm_overview                                    ← resynchro entre deux tâches
```

La feuille de route n'appartient à personne : n'importe quelle session
peut ajouter un jalon découvert en cours de route (`comm_plan action=add`),
passer un jalon en `active`, ou annoter (`action=update note=...`).

### Revue croisée avant merge

```
alice : comm_review action=request to=bob title="refacto auth"   ← diff stat joint
        comm_task action=next                                    ← elle enchaîne sans attendre
bob   : (notifié) comm_diff peer=alice mode=full path=src/auth
        comm_review action=approve id=R1 note="OK, attention au cache"
alice : (notifiée) merge → comm_review action=close id=R1
```

### À trois sessions ou plus

Mêmes règles. Donnez des rôles clairs (`lead`, `backend`, `frontend`,
`tests`...), un canal par projet (CLAUDE_COMM_CHANNEL), et appuyez-vous
davantage sur comm_overview (l'état global) que sur les messages directs.
Le broadcast `comm_send to="*"` sert aux annonces qui concernent tout le
monde (changement d'interface, rebase imminent).

### L'humain dans la boucle

Le propriétaire du projet peut superviser et intervenir sans session
Claude, via le CLI :

```
node server.js status                          # tableau de bord complet
CLAUDE_COMM_NAME=patron node server.js send "*" "Priorité au bugfix #42, le reste attend"
CLAUDE_COMM_NAME=patron node server.js inbox   # lire les réponses des sessions
```

Les sessions le voient comme un pair (« patron ») et peuvent lui écrire.
