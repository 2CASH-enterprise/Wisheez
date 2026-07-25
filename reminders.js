/**
 * reminders.js — relances proactives avant les fêtes calendaires.
 *
 * IMPORTANT : un rappel envoyé sans que l'utilisateur ait écrit dans les
 * dernières 24h est un message "business-initiated" côté WhatsApp — donc
 * soumis à un template approuvé par Meta (catégorie Marketing), exactement
 * comme discuté pour l'envoi aux invités du mariage. Tant que ce template
 * n'est pas approuvé, sendReminder() se contente de logger ce qu'il *aurait*
 * envoyé — cherchez TODO ci-dessous pour brancher l'envoi réel plus tard.
 */

const fs = require("fs");
const path = require("path");
const { getOccasionsWithNextDate } = require("./calendar");

const DB_PATH = path.join(__dirname, "..", "data", "users.json");
const SENT_LOG_PATH = path.join(__dirname, "..", "data", "reminders-sent.json");

function loadUsers() {
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function loadSentLog() {
  if (!fs.existsSync(SENT_LOG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SENT_LOG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function markAsSent(occasionId, year, waId) {
  const log = loadSentLog();
  const key = `${occasionId}-${year}`;
  if (!log[key]) log[key] = [];
  if (!log[key].includes(waId)) log[key].push(waId);
  fs.mkdirSync(path.dirname(SENT_LOG_PATH), { recursive: true });
  fs.writeFileSync(SENT_LOG_PATH, JSON.stringify(log, null, 2), "utf-8");
}

function alreadySent(occasionId, year, waId) {
  const log = loadSentLog();
  const key = `${occasionId}-${year}`;
  return (log[key] || []).includes(waId);
}

/** Un utilisateur est éligible s'il a déjà utilisé le service au moins une fois
 *  (pas de relance à froid vers quelqu'un qui n'a jamais essayé) et n'a pas
 *  désactivé les rappels. */
function isEligible(user) {
  return user.cardsSent > 0 && user.optedInMarketing !== false;
}

/** Retourne les occasions dont la fenêtre de relance est ouverte aujourd'hui. */
function getOccasionsToRemindNow(referenceDate = new Date()) {
  const occasions = getOccasionsWithNextDate(referenceDate);
  return occasions.filter((occ) => {
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysUntil = Math.round((occ.nextDate - referenceDate) / msPerDay);
    return daysUntil === occ.leadDays;
  });
}

function buildReminderText(occasion) {
  return `${occasion.label} approche 🎉 ${occasion.messageHint}\n\nÉcrivez-moi "carte" pour en créer une en quelques minutes.`;
}

/**
 * Point d'entrée principal, à appeler une fois par jour (voir cron dans server.js).
 * Pour chaque fête dont la fenêtre de relance s'ouvre aujourd'hui, identifie
 * les utilisateurs éligibles qui n'ont pas déjà reçu ce rappel cette année.
 */
async function runDailyReminderCheck(sendReminderFn) {
  const today = new Date();
  const occasionsToday = getOccasionsToRemindNow(today);
  if (occasionsToday.length === 0) return { sent: 0, occasions: [] };

  const users = loadUsers();
  const year = today.getFullYear();
  let sentCount = 0;

  for (const occasion of occasionsToday) {
    const eligibleUsers = Object.values(users).filter(
      (u) => isEligible(u) && !alreadySent(occasion.id, year, u.waId)
    );

    for (const user of eligibleUsers) {
      const text = buildReminderText(occasion);
      await sendReminderFn(user.waId, text, occasion); // TODO : voir server.js
      markAsSent(occasion.id, year, user.waId);
      sentCount++;
    }
  }

  return { sent: sentCount, occasions: occasionsToday.map((o) => o.label) };
}

module.exports = { runDailyReminderCheck, getOccasionsToRemindNow, isEligible };
