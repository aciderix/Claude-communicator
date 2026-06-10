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

4. RÉPARTITION — Le travail passe par le tableau partagé comm_task :
   - décomposez d'abord le travail en tâches (action=add),
   - prends la prochaine tâche libre avec action=next (claim atomique),
   - marque action=done avec une note de résultat,
   - ne travaille JAMAIS sur une tâche prise par l'autre.

5. ANTI-COLLISION — Avant d'éditer des fichiers que l'autre pourrait
   toucher, verrouille-les : comm_lock action=acquire paths=[...].
   Libère dès que tu as fini. Si un verrou est refusé, travaille sur
   autre chose ou attends avec comm_wait until=locks.

6. VISIBILITÉ — Pour savoir où en est l'autre sans le déranger :
   comm_status_get (état publié) et comm_diff (son diff git en direct).
   Pour un compte-rendu actif : comm_send kind=status_request, puis
   comm_inbox wait_seconds=60.

7. SYNCHRONISATION — Si tu dépends du travail de l'autre, ne tourne pas
   en boucle : utilise comm_wait (until=message / peer_status / tasks).

8. FIN — Quand le tableau est vide et ton travail poussé :
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
