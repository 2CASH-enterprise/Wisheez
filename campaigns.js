/**
 * campaigns.js — packs événement (remerciements/annonces/invitations envoyés
 * à plusieurs destinataires), avec la même histoire de base mais un rendu
 * vidéo personnalisé (prénom incrusté) par destinataire.
 */

const fs = require("fs");
const path = require("path");

const PRICE_SOLO_CENTS = 299; // 1 seul destinataire
const PRICE_VOLUME_PER_UNIT_CENTS = 150; // 5 à 199 destinataires
const VOLUME_MIN = 5;
const QUOTE_THRESHOLD = 200; // 200+ : sur devis, pas de calcul automatique

const CAMPAIGNS_PATH = path.join(__dirname, "..", "data", "campaigns.json");

/** Calcule le tarif selon le nombre de destinataires. */
function calculatePrice(recipientCount) {
  if (recipientCount <= 1) {
    return { tier: "solo", perUnitCents: PRICE_SOLO_CENTS, totalCents: PRICE_SOLO_CENTS, recipientCount };
  }
  if (recipientCount >= QUOTE_THRESHOLD) {
    return { tier: "quote", perUnitCents: null, totalCents: null, recipientCount };
  }
  if (recipientCount >= VOLUME_MIN) {
    return {
      tier: "volume",
      perUnitCents: PRICE_VOLUME_PER_UNIT_CENTS,
      totalCents: PRICE_VOLUME_PER_UNIT_CENTS * recipientCount,
      recipientCount,
    };
  }
  // 2 à 4 destinataires : pas encore le tarif volume, facturé à la personne
  return {
    tier: "solo",
    perUnitCents: PRICE_SOLO_CENTS,
    totalCents: PRICE_SOLO_CENTS * recipientCount,
    recipientCount,
  };
}

function loadCampaigns() {
  if (!fs.existsSync(CAMPAIGNS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveCampaigns(data) {
  fs.mkdirSync(path.dirname(CAMPAIGNS_PATH), { recursive: true });
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function generateToken() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Crée un enregistrement de campagne. `recipients` est un tableau de prénoms
 * (strings). Chaque destinataire reçoit un token unique pour son lien de
 * réception personnel.
 */
function createCampaign({ ownerClientId, occasion, details, recipients, photoPath }) {
  const campaigns = loadCampaigns();
  const id = "camp-" + Date.now() + "-" + generateToken();
  const pricing = calculatePrice(recipients.length);

  campaigns[id] = {
    id,
    ownerClientId,
    occasion,
    details,
    photoPath: photoPath || null,
    recipients: recipients.map((name) => ({
      name,
      token: generateToken(),
      videoPath: null,
      status: "pending", // pending | rendered | sent
    })),
    pricing,
    status: pricing.tier === "quote" ? "awaiting_quote" : "awaiting_payment",
    // TODO : une fois Stripe branché, passer à "paid" seulement après confirmation
    // webhook, plutôt que de générer avant paiement confirmé.
    createdAt: new Date().toISOString(),
  };

  saveCampaigns(campaigns);
  return campaigns[id];
}

function getCampaign(id) {
  const campaigns = loadCampaigns();
  return campaigns[id] || null;
}

function updateCampaign(id, patch) {
  const campaigns = loadCampaigns();
  if (!campaigns[id]) return null;
  campaigns[id] = { ...campaigns[id], ...patch };
  saveCampaigns(campaigns);
  return campaigns[id];
}

function updateRecipient(campaignId, token, patch) {
  const campaigns = loadCampaigns();
  const campaign = campaigns[campaignId];
  if (!campaign) return null;
  const recipient = campaign.recipients.find((r) => r.token === token);
  if (!recipient) return null;
  Object.assign(recipient, patch);
  saveCampaigns(campaigns);
  return recipient;
}

module.exports = {
  calculatePrice,
  createCampaign,
  getCampaign,
  updateCampaign,
  updateRecipient,
  PRICE_SOLO_CENTS,
  PRICE_VOLUME_PER_UNIT_CENTS,
  VOLUME_MIN,
  QUOTE_THRESHOLD,
};
