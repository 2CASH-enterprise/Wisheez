/**
 * whatsapp.js — wrapper léger autour de l'API WhatsApp Cloud (Graph API).
 *
 * Variables d'environnement requises :
 *   WHATSAPP_TOKEN            token d'accès (System User token permanent, pas le token 24h de test)
 *   WHATSAPP_PHONE_NUMBER_ID  l'ID du numéro (pas le numéro lui-même) depuis Meta Business Manager
 *   GRAPH_API_VERSION         optionnel, ex. "v20.0"
 */

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

const BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

async function callGraphAPI(body) {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Erreur WhatsApp API:", JSON.stringify(data));
    throw new Error(data.error?.message || "Erreur envoi WhatsApp");
  }
  return data;
}

/** Envoie un message texte simple. */
function sendText(to, body) {
  return callGraphAPI({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

/**
 * Envoie une vidéo par lien public (le serveur héberge le fichier lui-même
 * via express.static — voir server.js). Meta va récupérer le fichier à ce lien.
 */
function sendVideo(to, videoUrl, caption) {
  return callGraphAPI({
    messaging_product: "whatsapp",
    to,
    type: "video",
    video: { link: videoUrl, caption },
  });
}

/** Marque un message entrant comme lu (coche bleue), optionnel mais plus humain. */
function markAsRead(messageId) {
  return callGraphAPI({
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}

/**
 * Extrait le message texte entrant d'un événement webhook WhatsApp.
 * Retourne null si l'événement n'est pas un message texte utilisateur
 * (accusés de lecture, messages non-texte, etc.), pour que server.js
 * puisse les ignorer proprement.
 */
function parseIncomingMessage(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  if (!message) return null;

  return {
    waId: message.from,
    messageId: message.id,
    type: message.type,
    text: message.type === "text" ? message.text.body.trim() : null,
    profileName: value.contacts?.[0]?.profile?.name || null,
  };
}

module.exports = { sendText, sendVideo, markAsRead, parseIncomingMessage };
