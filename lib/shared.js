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
      const t = db.tasks.find((t) => t.status === 'todo' && !t.owner);
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
      return {
        changed: true, result: { type: 'done', task: t, remaining },
        notify: { subject: 'tâche terminée', body: `${actor} a terminé ${t.id} : ${t.title}${a.note ? `\n${a.note}` : ''}` },
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

module.exports = {
  sanitizeName, nowISO, newId, normalizePath, pathsOverlap,
  emptyTasks, applyTaskAction, applyLockAction, applyNoteAction,
};
