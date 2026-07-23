/**
 * store.js — persistance simple sur fichier JSON.
 *
 * Pour démarrer, un fichier suffit. Le jour où le volume grandit,
 * remplacez ce module par une vraie base (SQLite ou Postgres) sans
 * toucher au reste du serveur : gardez juste les mêmes fonctions.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "users.json");

function loadAll() {
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveAll(data) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function getUser(waId) {
  const all = loadAll();
  if (!all[waId]) {
    all[waId] = {
      waId,
      state: "new", // new | awaiting_destinataire | awaiting_occasion | awaiting_details | generating
      draft: {}, // { destinataire, occasion, details }
      cardsSent: 0,
      credit: 0, // en centimes d'euro, pour plus tard (Stripe)
      createdAt: new Date().toISOString(),
    };
    saveAll(all);
  }
  return all[waId];
}

function updateUser(waId, patch) {
  const all = loadAll();
  all[waId] = { ...(all[waId] || getUser(waId)), ...patch };
  saveAll(all);
  return all[waId];
}

function hasFreeCardLeft(user) {
  return user.cardsSent === 0;
}

module.exports = { getUser, updateUser, hasFreeCardLeft };
