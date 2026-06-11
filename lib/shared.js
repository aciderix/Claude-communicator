/*
 * Logique partagée entre le serveur MCP (server.js) et le relais réseau
 * (relay.js). Les opérations sur le tableau de tâches, les verrous et les
 * notes sont des fonctions pures appliquées sur l'état : les deux modes
 * (hub fichier local / relais multi-machines) ont ainsi exactement les
 * mêmes sémantiques.
 */
'use strict';

const crypto = require('crypto');

function sanitizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40) || 'anon';
}

function nowISO() { return new Date().toISOString(); }

function newId() { return crypto.randomBytes(4).toString('hex'); }

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathsOverlap(a, b) {
  a = normalizePath(a); b = normalizePath(b);
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

function emptyTasks() { return { next_id: 1, tasks: [] }; }

const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];

// Dépendances non satisfaites d'une tâche (ids non terminés ou inconnus).
function unmetDeps(db, t) {
  return (t.deps || []).filter((id) => {
    const d = db.tasks.find((x) => x.id === id);
    return !d || d.status !== 'done';
  });
}

/*
 * Applique une action sur le tableau de tâches (muté en place).
 * Retourne { changed, result, notify? } :
 *  - result : objet structuré que l'appelant met en forme
 *  - notify : { subject, body } à diffuser aux pairs (hors acteur)
 * Lève une Error pour les actions invalides.
 */
function applyTaskAction(db, actor, a = {}) {
  const find = (id) => {
    const t = db.tasks.find((t) => t.id === String(id || '').toUpperCase());
    if (!t) throw new Error(`Tâche inconnue : "${id}". Utilise action=list.`);
    return t;
  };
  const touch = (t, note) => {
    t.updated_at = nowISO();
    if (note) (t.notes = t.notes || []).push(`[${actor}] ${String(note).slice(0, 500)}`);
  };

  switch (a.action) {
    case 'add': {
      if (!a.title) throw new Error('Paramètre requis pour add : title.');
      const t = {
        id: `T${db.next_id++}`,
        title: String(a.title).slice(0, 300),
        detail: String(a.detail || '').slice(0, 2000),
        milestone: a.milestone ? String(a.milestone).toUpperCase().slice(0, 8) : null,
        deps: Array.isArray(a.deps)
          ? a.deps.map((d) => String(d).toUpperCase().slice(0, 8)).slice(0, 16)
          : [],
        status: 'todo', owner: null, created_by: actor,
        created_at: nowISO(), updated_at: nowISO(), notes: [],
      };
      db.tasks.push(t);
      return {
        changed: true, result: { type: 'task', task: t },
        notify: { subject: 'nouvelle tâche', body: `${actor} a ajouté ${t.id} : ${t.title}` },
      };
    }
    case 'list':
      return { changed: false, result: { type: 'list', tasks: db.tasks } };
    case 'next': {
      // priorité aux tâches qui m'ont été assignées, puis aux tâches libres ;
      // les tâches aux dépendances non résolues sont ignorées
      const ready = (t) => t.status === 'todo' && !unmetDeps(db, t).length;
      const t = db.tasks.find((t) => ready(t) && t.owner === actor) ||
        db.tasks.find((t) => ready(t) && !t.owner);
      if (!t) return { changed: false, result: { type: 'none' } };
      t.owner = actor; t.status = 'in_progress';
      touch(t, 'prise (next)');
      return {
        changed: true, result: { type: 'claimed', task: t },
        notify: { subject: 'tâche prise', body: `${actor} prend ${t.id} : ${t.title}` },
      };
    }
    case 'claim': {
      const t = find(a.id);
      if (t.owner && t.owner !== actor) {
        throw new Error(`${t.id} est déjà prise par ${t.owner}. Prends-en une autre (action=next) ou demande-lui de la libérer.`);
      }
      const unmet = unmetDeps(db, t);
      if (unmet.length) {
        throw new Error(`Dépendances non terminées pour ${t.id} : ${unmet.join(', ')}. Prends une autre tâche en attendant.`);
      }
      t.owner = actor; t.status = 'in_progress';
      touch(t, 'prise (claim)');
      return {
        changed: true, result: { type: 'claimed', task: t },
        notify: { subject: 'tâche prise', body: `${actor} prend ${t.id} : ${t.title}` },
      };
    }
    case 'update': {
      const t = find(a.id);
      if (a.status) {
        if (!TASK_STATUSES.includes(a.status)) throw new Error(`Statut invalide : ${a.status}`);
        t.status = a.status;
      }
      touch(t, a.note || (a.status ? `statut → ${a.status}` : 'mise à jour'));
      return {
        changed: true, result: { type: 'task', task: t },
        notify: a.status === 'blocked'
          ? { subject: 'tâche bloquée', body: `${actor} : ${t.id} bloquée — ${a.note || t.title}` }
          : null,
      };
    }
    case 'done': {
      const t = find(a.id);
      t.status = 'done'; t.owner = t.owner || actor;
      touch(t, a.note || 'terminée');
      const remaining = db.tasks.filter((x) => x.status !== 'done').length;
      const unblocked = db.tasks
        .filter((x) => x.status === 'todo' && (x.deps || []).includes(t.id) && !unmetDeps(db, x).length)
        .map((x) => x.id);
      return {
        changed: true, result: { type: 'done', task: t, remaining, unblocked },
        notify: {
          subject: 'tâche terminée',
          body: `${actor} a terminé ${t.id} : ${t.title}${a.note ? `\n${a.note}` : ''}` +
            (unblocked.length ? `\n⛓ Débloquées : ${unblocked.join(', ')}` : ''),
        },
      };
    }
    case 'assign': {
      if (!a.to) throw new Error('Paramètre requis pour assign : to.');
      const t = find(a.id);
      const to = sanitizeName(a.to);
      if (t.owner && t.owner !== actor && t.owner !== to) {
        throw new Error(`${t.id} appartient à ${t.owner} : demande-lui de la libérer d'abord.`);
      }
      t.owner = to; t.status = 'todo';
      touch(t, `assignée à ${to} par ${actor}`);
      return {
        changed: true, result: { type: 'assigned', task: t, to },
        notify: { subject: 'tâche assignée', body: `${actor} a assigné ${t.id} à ${to} : ${t.title}` },
      };
    }
    case 'release': {
      const t = find(a.id);
      if (t.owner !== actor) throw new Error(`${t.id} ne t'appartient pas (owner: ${t.owner || 'aucun'}).`);
      t.owner = null; t.status = 'todo';
      touch(t, a.note || 'libérée');
      return {
        changed: true, result: { type: 'released_task', task: t },
        notify: { subject: 'tâche libérée', body: `${actor} a libéré ${t.id} : ${t.title}` },
      };
    }
    default:
      throw new Error(`Action inconnue : ${a.action}`);
  }
}

/*
 * Applique une action sur la liste des verrous.
 * Retourne { locks (nouvelle liste), changed, result, notify? }.
 */
function applyLockAction(locks, actor, a = {}) {
  switch (a.action) {
    case 'acquire': {
      const paths = (a.paths || []).map(normalizePath).filter(Boolean);
      if (!paths.length) throw new Error('Paramètre requis pour acquire : paths.');
      const conflicts = [];
      for (const p of paths) {
        for (const l of locks) {
          if (l.owner !== actor && pathsOverlap(p, l.path)) conflicts.push({ path: p, lock: l });
        }
      }
      if (conflicts.length) return { locks, changed: false, result: { type: 'conflict', conflicts } };
      const next = locks.filter((l) => !(l.owner === actor && paths.includes(l.path)));
      for (const p of paths) {
        next.push({ path: p, owner: actor, reason: String(a.reason || '').slice(0, 300), ts: nowISO() });
      }
      return { locks: next, changed: true, result: { type: 'acquired', paths } };
    }
    case 'release': {
      const want = (a.paths || []).map(normalizePath);
      const mine = locks.filter((l) => l.owner === actor && (!want.length || want.includes(l.path)));
      if (!mine.length) return { locks, changed: false, result: { type: 'released', paths: [] } };
      const released = mine.map((l) => l.path);
      const next = locks.filter((l) => !mine.includes(l));
      return {
        locks: next, changed: true, result: { type: 'released', paths: released },
        notify: { subject: 'verrous libérés', body: `${actor} a libéré : ${released.join(', ')}` },
      };
    }
    case 'list':
      return { locks, changed: false, result: { type: 'list', locks } };
    default:
      throw new Error(`Action inconnue : ${a.action}`);
  }
}

/*
 * Journal partagé de notes/décisions (muté en place).
 */
function applyNoteAction(notes, actor, a = {}) {
  switch (a.action) {
    case 'add': {
      if (!a.text) throw new Error('Paramètre requis pour add : text.');
      const n = {
        id: newId(), by: actor, ts: nowISO(),
        text: String(a.text).slice(0, 4000),
        tags: (Array.isArray(a.tags) ? a.tags : []).map((t) => sanitizeName(t)).slice(0, 8),
      };
      notes.push(n);
      if (notes.length > 500) notes.splice(0, notes.length - 500);
      return {
        changed: true, result: { type: 'note', note: n },
        notify: { subject: 'note partagée', body: `${actor} a noté : ${n.text.slice(0, 400)}` },
      };
    }
    case 'list': {
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
      let out = notes;
      if (a.tag) out = out.filter((n) => (n.tags || []).includes(sanitizeName(a.tag)));
      return { changed: false, result: { type: 'list', notes: out.slice(-limit) } };
    }
    default:
      throw new Error(`Action inconnue : ${a.action}`);
  }
}

function emptyPlan() { return { goal: '', next_id: 1, milestones: [] }; }

const PLAN_STATUSES = ['todo', 'active', 'done', 'dropped'];

/*
 * Feuille de route partagée : un cap (goal) + des jalons (M1, M2...) que
 * toutes les sessions peuvent compléter. Les tâches du tableau s'y
 * rattachent via leur champ milestone.
 */
function applyPlanAction(plan, actor, a = {}) {
  const find = (id) => {
    const m = plan.milestones.find((m) => m.id === String(id || '').toUpperCase());
    if (!m) throw new Error(`Jalon inconnu : "${id}". Utilise action=list.`);
    return m;
  };
  const touch = (m, note) => {
    m.updated_at = nowISO();
    if (note) (m.notes = m.notes || []).push(`[${actor}] ${String(note).slice(0, 500)}`);
  };

  switch (a.action) {
    case 'goal': {
      if (!a.text) throw new Error('Paramètre requis pour goal : text.');
      plan.goal = String(a.text).slice(0, 2000);
      return {
        changed: true, result: { type: 'goal', goal: plan.goal },
        notify: { subject: 'cap mis à jour', body: `${actor} a fixé le cap : ${plan.goal}` },
      };
    }
    case 'add': {
      if (!a.title) throw new Error('Paramètre requis pour add : title.');
      const m = {
        id: `M${plan.next_id++}`,
        title: String(a.title).slice(0, 300),
        detail: String(a.detail || '').slice(0, 2000),
        status: 'todo', created_by: actor,
        created_at: nowISO(), updated_at: nowISO(), notes: [],
      };
      plan.milestones.push(m);
      return {
        changed: true, result: { type: 'milestone', milestone: m },
        notify: { subject: 'feuille de route', body: `${actor} a ajouté le jalon ${m.id} : ${m.title}` },
      };
    }
    case 'update': {
      const m = find(a.id);
      if (a.title) m.title = String(a.title).slice(0, 300);
      if (a.detail !== undefined) m.detail = String(a.detail).slice(0, 2000);
      if (a.status) {
        if (!PLAN_STATUSES.includes(a.status)) throw new Error(`Statut invalide : ${a.status} (todo|active|done|dropped).`);
        m.status = a.status;
      }
      touch(m, a.note || (a.status ? `statut → ${a.status}` : 'mise à jour'));
      return {
        changed: true, result: { type: 'milestone', milestone: m },
        notify: { subject: 'feuille de route', body: `${actor} a mis à jour ${m.id}${a.status ? ` → ${a.status}` : ''} : ${m.title}` },
      };
    }
    case 'done': {
      const m = find(a.id);
      m.status = 'done';
      touch(m, a.note || 'terminé');
      return {
        changed: true, result: { type: 'milestone', milestone: m },
        notify: { subject: 'jalon terminé', body: `${actor} a terminé ${m.id} : ${m.title} 🎉` },
      };
    }
    case 'list':
      return { changed: false, result: { type: 'plan', plan } };
    default:
      throw new Error(`Action inconnue : ${a.action}`);
  }
}

function emptyReviews() { return { next_id: 1, items: [] }; }

/*
 * Revues croisées : une session demande à une autre de relire son travail
 * avant merge. Seul le relecteur désigné peut approuver / demander des
 * changements ; seul le demandeur peut clore.
 */
function applyReviewAction(reviews, actor, a = {}) {
  const find = (id) => {
    const r = reviews.items.find((r) => r.id === String(id || '').toUpperCase());
    if (!r) throw new Error(`Revue inconnue : "${id}". Utilise action=list.`);
    return r;
  };

  switch (a.action) {
    case 'request': {
      if (!a.to) throw new Error('Paramètre requis pour request : to.');
      const to = sanitizeName(a.to);
      const r = {
        id: `R${reviews.next_id++}`, from: actor, to, status: 'pending',
        title: String(a.title || '').slice(0, 300),
        note: String(a.note || '').slice(0, 2000),
        diff: String(a.diff || '').slice(0, 4000),
        created_at: nowISO(), updated_at: nowISO(),
        events: [`[${actor}] revue demandée à ${to}`],
      };
      reviews.items.push(r);
      if (reviews.items.length > 200) reviews.items.splice(0, reviews.items.length - 200);
      return {
        changed: true, result: { type: 'review', review: r },
        notify: {
          subject: 'revue demandée',
          body: `${actor} demande une revue à ${to} : ${r.id}${r.title ? ` — ${r.title}` : ''}${r.note ? `\n${r.note}` : ''}`,
        },
      };
    }
    case 'approve':
    case 'changes': {
      const r = find(a.id);
      if (r.to !== actor) throw new Error(`Seul ${r.to} peut se prononcer sur ${r.id}.`);
      if (r.status !== 'pending' && r.status !== 'changes_requested') {
        throw new Error(`${r.id} est déjà "${r.status}".`);
      }
      r.status = a.action === 'approve' ? 'approved' : 'changes_requested';
      r.updated_at = nowISO();
      r.events.push(`[${actor}] ${r.status}${a.note ? ` — ${String(a.note).slice(0, 500)}` : ''}`);
      return {
        changed: true, result: { type: 'review', review: r },
        notify: {
          subject: a.action === 'approve' ? 'revue approuvée' : 'changements demandés',
          body: `${actor} : ${r.id} → ${r.status}${a.note ? `\n${a.note}` : ''}`,
        },
      };
    }
    case 'close': {
      const r = find(a.id);
      if (r.from !== actor) throw new Error(`Seul ${r.from} peut clore ${r.id}.`);
      r.status = 'closed';
      r.updated_at = nowISO();
      r.events.push(`[${actor}] close${a.note ? ` — ${String(a.note).slice(0, 500)}` : ''}`);
      return {
        changed: true, result: { type: 'review', review: r },
        notify: { subject: 'revue close', body: `${actor} a clos ${r.id}.` },
      };
    }
    case 'list':
      return { changed: false, result: { type: 'reviews', reviews: reviews.items } };
    default:
      throw new Error(`Action inconnue : ${a.action}`);
  }
}

function emptyUser() {
  return { msgs: { next_id: 1, items: [] }, questions: { next_id: 1, items: [] } };
}

const CLAIM_STALE_MS = 10 * 60 * 1000;

/*
 * Interactions des sessions avec l'utilisateur humain (dashboard / CLI).
 * Pour les messages utilisateur adressés à tous, le mécanisme de claim
 * garantit qu'une seule session rédige la réponse (économie de tokens) ;
 * la réponse publiée est notifiée aux pairs, qui peuvent compléter.
 */
function applyUserAction(u, actor, a = {}) {
  const findMsg = (id) => {
    const m = u.msgs.items.find((m) => m.id === String(id || '').toUpperCase());
    if (!m) throw new Error(`Message utilisateur inconnu : "${id}". Utilise action=list.`);
    return m;
  };

  switch (a.action) {
    case 'claim': {
      const m = findMsg(a.id);
      if (m.status === 'answered') {
        throw new Error(`${m.id} a déjà reçu une réponse. Lis-la (action=list) et complète seulement si nécessaire.`);
      }
      if (m.status === 'claimed' && m.claimed_by !== actor &&
          Date.now() - Date.parse(m.claimed_at || 0) < CLAIM_STALE_MS) {
        throw new Error(`Réponse à ${m.id} déjà en cours de rédaction par ${m.claimed_by}. ` +
          `Ne rédige PAS la tienne : tu verras sa réponse et pourras compléter si elle est incorrecte.`);
      }
      m.status = 'claimed'; m.claimed_by = actor; m.claimed_at = nowISO();
      return {
        changed: true, result: { type: 'claimed_msg', msg: m },
        notify: {
          subject: 'réponse en cours',
          body: `${actor} rédige la réponse à ${m.id}. Ne traite pas ce message — ` +
            `tu seras notifié de sa réponse et pourras compléter si nécessaire.`,
        },
      };
    }
    case 'reply': {
      if (!a.body) throw new Error('Paramètre requis pour reply : body.');
      const m = findMsg(a.id);
      const reply = { by: actor, ts: nowISO(), body: String(a.body).slice(0, 8000) };
      m.replies.push(reply);
      m.status = 'answered';
      return {
        changed: true, result: { type: 'replied', msg: m },
        notify: {
          subject: `réponse publiée à ${m.id}`,
          body: `${actor} a répondu à la demande utilisateur ${m.id} :\n${reply.body.slice(0, 1500)}\n` +
            `(Si cette réponse est incorrecte ou incomplète, complète avec comm_user action=reply id=${m.id}. Sinon, n'y consacre pas de tokens.)`,
        },
      };
    }
    case 'ask': {
      if (!a.text) throw new Error('Paramètre requis pour ask : text.');
      const q = {
        id: `Q${u.questions.next_id++}`, from: actor, ts: nowISO(),
        text: String(a.text).slice(0, 1000),
        options: (Array.isArray(a.options) ? a.options : []).map((o) => String(o).slice(0, 200)).slice(0, 8),
        context: String(a.context || '').slice(0, 2000),
        status: 'open', answer: null, answered_at: null,
      };
      u.questions.items.push(q);
      if (u.questions.items.length > 200) u.questions.items.splice(0, u.questions.items.length - 200);
      return {
        changed: true, result: { type: 'question', question: q },
        notify: {
          subject: `question à l'utilisateur`,
          body: `${actor} a posé ${q.id} à l'utilisateur : ${q.text}\n` +
            `Sa réponse sera diffusée à tous. Si TU connais déjà la réponse, dis-le à ${actor} via comm_send.`,
        },
      };
    }
    case 'list':
      return {
        changed: false,
        result: {
          type: 'user_list',
          msgs: u.msgs.items.slice(-10),
          questions: u.questions.items.filter((q) => q.status === 'open')
            .concat(u.questions.items.filter((q) => q.status === 'answered').slice(-5)),
        },
      };
    default:
      throw new Error(`Action inconnue : ${a.action}`);
  }
}

/*
 * Message envoyé PAR l'utilisateur (dashboard/CLI) vers les sessions.
 * Retourne le message créé et les livraisons à effectuer dans les boîtes.
 */
function userPost(u, sessionNames, { to, body }) {
  if (!body) throw new Error('Paramètre requis : body.');
  let targets;
  if (to === '*' || to === 'all' || !to) {
    targets = sessionNames.slice();
    if (!targets.length) throw new Error('Aucune session connectée.');
  } else {
    const t = sanitizeName(to);
    if (!sessionNames.includes(t)) throw new Error(`Session inconnue : "${to}".`);
    targets = [t];
  }
  const broadcast = targets.length > 1;
  const m = {
    id: `U${u.msgs.next_id++}`, ts: nowISO(), to: broadcast ? '*' : targets[0],
    body: String(body).slice(0, 8000),
    status: 'open', claimed_by: null, claimed_at: null, replies: [],
  };
  u.msgs.items.push(m);
  if (u.msgs.items.length > 200) u.msgs.items.splice(0, u.msgs.items.length - 200);
  const subject = broadcast
    ? `${m.id} (à tous) — AVANT de répondre : comm_user action=claim id=${m.id}`
    : `${m.id} — réponds via comm_user action=reply id=${m.id}`;
  const deliveries = targets.map((t) => ({
    to: t,
    message: { id: newId(), from: 'user', to: t, kind: 'question', subject, body: m.body, reply_to: null, ts: m.ts },
  }));
  return { msg: m, deliveries };
}

/*
 * Réponse de l'utilisateur à une question posée par une session.
 * La notification retournée est à diffuser à TOUTES les sessions.
 */
function userAnswer(u, { id, answer }) {
  if (!answer) throw new Error('Paramètre requis : answer.');
  const q = u.questions.items.find((q) => q.id === String(id || '').toUpperCase());
  if (!q) throw new Error(`Question inconnue : "${id}".`);
  q.status = 'answered';
  q.answer = String(answer).slice(0, 4000);
  q.answered_at = nowISO();
  return {
    question: q,
    notify: {
      subject: `réponse utilisateur à ${q.id}`,
      body: `L'utilisateur a répondu à ${q.id} (« ${q.text} ») :\n${q.answer}`,
    },
  };
}

function emptyConfig() {
  return { standup_minutes: 0, last_standup_at: null, last_standup_hash: '' };
}

/*
 * Digest compact de l'état du canal (généré sans LLM, envoyé seulement
 * s'il a changé depuis le précédent : économie de tokens).
 */
function standupDigest(snap) {
  const L = [];
  const ses = (snap.sessions || []).map((s) =>
    `${s.name}:${s.state || 'idle'}${s.task ? ` (${s.task})` : ''}`).join(' · ') || 'aucune';
  L.push(`Sessions : ${ses}`);
  const tasks = snap.tasks.tasks;
  const open = tasks.filter((t) => t.status !== 'done');
  L.push(`Tâches : ${open.length} ouverte(s)` +
    (open.length ? ` [${open.map((t) => `${t.id}${t.owner ? `→${t.owner}` : ''}`).join(', ')}]` : '') +
    ` · ${tasks.length - open.length} faite(s)`);
  if (snap.plan && snap.plan.milestones.length) {
    L.push('Plan : ' + snap.plan.milestones.map((m) => {
      const lk = tasks.filter((t) => t.milestone === m.id);
      const dd = lk.filter((t) => t.status === 'done').length;
      return `${m.id} ${m.status === 'done' ? '✅' : lk.length ? `${dd}/${lk.length}` : m.status}`;
    }).join(' · '));
  }
  const pr = ((snap.reviews && snap.reviews.items) || [])
    .filter((r) => r.status === 'pending' || r.status === 'changes_requested');
  if (pr.length) L.push(`Revues en attente : ${pr.map((r) => `${r.id} (${r.from}→${r.to})`).join(', ')}`);
  if ((snap.locks || []).length) L.push(`Verrous : ${snap.locks.map((l) => `${l.path}(${l.owner})`).join(', ')}`);
  const oq = ((snap.user && snap.user.questions.items) || []).filter((q) => q.status === 'open');
  if (oq.length) L.push(`Questions à l'utilisateur sans réponse : ${oq.map((q) => q.id).join(', ')}`);
  return L.join('\n');
}

module.exports = {
  sanitizeName, nowISO, newId, normalizePath, pathsOverlap,
  emptyTasks, applyTaskAction, applyLockAction, applyNoteAction, unmetDeps,
  emptyPlan, applyPlanAction, emptyReviews, applyReviewAction,
  emptyUser, applyUserAction, userPost, userAnswer,
  emptyConfig, standupDigest,
};
