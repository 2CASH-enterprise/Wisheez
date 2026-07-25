require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const multer = require("multer");
const { getUser, updateUser, hasFreeCardLeft } = require("./lib/store");
const { sendText, sendVideo, markAsRead, parseIncomingMessage } = require("./lib/whatsapp");
const { generateCard, writeCampaignTemplate, renderCampaignRecipient } = require("./lib/generate");
const { runDailyReminderCheck } = require("./lib/reminders");
const { calculatePrice, createCampaign, getCampaign, updateRecipient } = require("./lib/campaigns");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // sert creer.html, index.html si copiés ici

const upload = multer({
  dest: path.join(__dirname, "uploads_tmp"),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo, large marge sous la limite WhatsApp
});

// Sert les vidéos générées à une URL publique, ex :
// https://votredomaine.com/media/abc123.mp4 — c'est ce lien qu'on donne à WhatsApp.
app.use("/media", express.static(path.join(__dirname, "public", "media")));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // ex: https://wisheez.votredomaine.com
const CARD_PRICE_CENTS = 299;

// ---------- 1. Vérification du webhook (obligatoire, une seule fois côté Meta) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook vérifié avec succès.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- 2. Réception des messages ----------
app.post("/webhook", async (req, res) => {
  // Répondre 200 tout de suite : WhatsApp réessaie sinon si on met trop de temps.
  res.sendStatus(200);

  const incoming = parseIncomingMessage(req.body);
  if (!incoming || incoming.type !== "text") return; // on ignore le reste pour l'instant

  try {
    await markAsRead(incoming.messageId);
    await handleMessage(incoming);
  } catch (err) {
    console.error("Erreur traitement message:", err);
    await sendText(
      incoming.waId,
      "Désolé, un souci technique est survenu. Réessayez dans un instant 🙏"
    ).catch(() => {});
  }
});

// ---------- 3. API pour le formulaire web (point d'entrée QR code / page web) ----------
app.post("/api/generate", upload.single("photo"), async (req, res) => {
  const { clientId, destinataire, occasion, details } = req.body;

  if (!clientId || !destinataire || !occasion || !details) {
    return res.status(400).json({ error: "missing_fields", message: "Tous les champs sont requis." });
  }

  const user = getUser(clientId);
  const isFree = hasFreeCardLeft(user);

  if (!isFree && user.credit < CARD_PRICE_CENTS) {
    // TODO : remplacer par un vrai lien de paiement Stripe une fois branché.
    return res.status(402).json({
      error: "payment_required",
      message: "Votre carte gratuite a déjà été utilisée. La suivante coûte 2,99 €.",
    });
  }

  try {
    const draft = { destinataire, occasion, details };
    if (req.file) draft.photoPath = req.file.path;

    const cardId = `${clientId}-${Date.now()}`;
    const videoPath = await generateCard(draft, cardId);
    const videoUrl = `${PUBLIC_BASE_URL}/media/${path.basename(videoPath)}`;

    const newCount = user.cardsSent + 1;
    const newCredit = isFree ? user.credit : user.credit - CARD_PRICE_CENTS;
    updateUser(clientId, { cardsSent: newCount, credit: newCredit });

    if (req.file) fs.unlink(req.file.path, () => {}); // nettoyage du fichier temporaire

    res.json({ videoUrl, isFree });
  } catch (err) {
    console.error("Erreur génération (web):", err);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: "generation_failed", message: "La génération a échoué, réessayez." });
  }
});

// ---------- 3c. Packs événement (plusieurs destinataires, même histoire) ----------

// Calcul de prix en direct, pour affichage avant validation (aucune génération ici).
app.post("/api/campaign/quote", (req, res) => {
  const count = parseInt(req.body.recipientCount, 10);
  if (!count || count < 1) return res.status(400).json({ error: "invalid_count" });
  res.json(calculatePrice(count));
});

// Création d'une campagne : calcule le prix, enregistre les destinataires,
// mais NE GÉNÈRE RIEN tant que le paiement n'est pas confirmé.
app.post("/api/campaign", upload.single("photo"), async (req, res) => {
  const { clientId, occasion, details } = req.body;
  let recipients = req.body.recipients;

  try {
    recipients = JSON.parse(recipients); // tableau de prénoms envoyé en JSON depuis le formulaire
  } catch {
    return res.status(400).json({ error: "invalid_recipients", message: "Liste de destinataires invalide." });
  }

  if (!clientId || !occasion || !details || !Array.isArray(recipients) || recipients.length < 1) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const pricing = calculatePrice(recipients.length);
  const campaign = createCampaign({
    ownerClientId: clientId,
    occasion,
    details,
    recipients,
    photoPath: req.file ? req.file.path : null,
  });

  if (pricing.tier === "quote") {
    return res.json({
      campaignId: campaign.id,
      pricing,
      message: "Plus de 200 destinataires : contactez-nous directement pour un tarif adapté.",
    });
  }

  // TODO : remplacer par un vrai lien de paiement Stripe pour pricing.totalCents.
  // Une fois le paiement confirmé (webhook Stripe), appeler l'équivalent de
  // POST /api/campaign/:id/generate ci-dessous automatiquement.
  res.json({
    campaignId: campaign.id,
    pricing,
    message: `Total : ${(pricing.totalCents / 100).toFixed(2)} € — lien de paiement à venir.`,
  });
});

// Déclenche la génération réelle (1 appel Claude + 1 rendu par destinataire).
// À appeler une fois le paiement confirmé — pour l'instant, déclenchable
// manuellement pour les tests.
app.post("/api/campaign/:id/generate", async (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: "not_found" });

  try {
    const templateHtmlPath = await writeCampaignTemplate(
      { destinataire: "{{PRENOM_INVITE}}", occasion: campaign.occasion, details: campaign.details, photoPath: campaign.photoPath },
      campaign.id
    );

    for (const recipient of campaign.recipients) {
      const outputId = `${campaign.id}-${recipient.token}`;
      const videoPath = renderCampaignRecipient(templateHtmlPath, recipient.name, outputId);
      updateRecipient(campaign.id, recipient.token, {
        videoPath: `${PUBLIC_BASE_URL}/media/${path.basename(videoPath)}`,
        status: "rendered",
      });
    }

    res.json({ campaignId: campaign.id, status: "done" });
  } catch (err) {
    console.error("Erreur génération campagne:", err);
    res.status(500).json({ error: "generation_failed" });
  }
});

// Statut d'une campagne (pour un tableau de bord simple côté client).
app.get("/api/campaign/:id", (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: "not_found" });
  res.json(campaign);
});

// Page/lien individuel qu'un destinataire reçoit (ex: via QR code ou lien direct).
app.get("/api/campaign/:id/recipient/:token", (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: "not_found" });
  const recipient = campaign.recipients.find((r) => r.token === req.params.token);
  if (!recipient) return res.status(404).json({ error: "not_found" });
  res.json({ name: recipient.name, videoUrl: recipient.videoPath, status: recipient.status });
});

// ---------- 3b. Logique de conversation (WhatsApp) ----------
async function handleMessage(incoming) {
  const { waId, text } = incoming;
  const user = getUser(waId);

  if (/^stop$/i.test(text.trim())) {
    updateUser(waId, { optedInMarketing: false });
    await sendText(waId, "C'est noté, vous ne recevrez plus de rappels de notre part. Vous pouvez toujours m'écrire directement pour créer une carte quand vous le souhaitez.");
    return;
  }

  switch (user.state) {
    case "new":
    case "done": {
      await sendText(
        waId,
        `Bonjour${incoming.profileName ? " " + incoming.profileName : ""} 👋 Je suis Wisheez, je crée des cartes de vœux animées, livrées ici même.\n\nPour qui est la carte ?`
      );
      updateUser(waId, { state: "awaiting_destinataire", draft: {} });
      break;
    }

    case "awaiting_destinataire": {
      updateUser(waId, {
        state: "awaiting_occasion",
        draft: { ...user.draft, destinataire: text },
      });
      await sendText(waId, `Quelle est l'occasion ? (anniversaire, mariage, félicitations...)`);
      break;
    }

    case "awaiting_occasion": {
      updateUser(waId, {
        state: "awaiting_details",
        draft: { ...user.draft, occasion: text },
      });
      await sendText(
        waId,
        `Dites-m'en un peu plus : le ton souhaité, une couleur, un détail qui compte pour cette personne.`
      );
      break;
    }

    case "awaiting_details": {
      const draft = { ...user.draft, details: text };
      const isFree = hasFreeCardLeft(user);

      // Pas de carte gratuite restante et pas assez de crédit : on arrête ici
      // et on redirige vers le paiement au lieu de générer.
      if (!isFree && user.credit < CARD_PRICE_CENTS) {
        updateUser(waId, { state: "awaiting_payment", draft });
        // TODO : remplacer par un vrai lien de paiement Stripe (Payment Link
        // ou Checkout Session créée à la volée), puis un webhook Stripe qui
        // appelle updateUser(waId, { credit: user.credit + amount }) et relance
        // handleMessage pour reprendre la génération automatiquement.
        await sendText(
          waId,
          `Votre carte gratuite a déjà été utilisée. La suivante coûte 2,99 € : [lien de paiement à venir]\n\nUne fois le paiement confirmé, votre carte part automatiquement.`
        );
        break;
      }

      updateUser(waId, { state: "generating", draft });

      const recap = `Carte pour *${draft.destinataire}* — ${draft.occasion}.`;
      await sendText(waId, `${recap}\nJe prépare votre carte, ça prend quelques instants ⏳`);

      const cardId = `${waId}-${Date.now()}`;
      const videoPath = await generateCard(draft, cardId);
      const videoUrl = `${PUBLIC_BASE_URL}/media/${path.basename(videoPath)}`;

      await sendVideo(waId, videoUrl, "Votre carte Wisheez 🎁");

      const newCount = user.cardsSent + 1;
      const newCredit = isFree ? user.credit : user.credit - CARD_PRICE_CENTS;
      updateUser(waId, { state: "done", cardsSent: newCount, credit: newCredit, draft: {} });

      if (isFree) {
        await sendText(
          waId,
          `Cette première carte est offerte 🎁 Les suivantes sont à 2,99 € pièce, sans abonnement.\n\nPour une nouvelle carte, écrivez-moi simplement à nouveau ici.`
        );
      } else {
        await sendText(
          waId,
          `Et voilà ! Pour une autre carte, écrivez-moi à nouveau ici quand vous en aurez besoin.`
        );
      }
      break;
    }

    case "awaiting_payment": {
      await sendText(
        waId,
        `Le paiement n'est pas encore confirmé de mon côté. Utilisez le lien reçu juste avant — je reprends automatiquement dès que c'est validé.`
      );
      break;
    }

    default: {
      updateUser(waId, { state: "new" });
      await sendText(waId, "Recommençons — pour qui est la carte ?");
    }
  }
}

// ---------- 4. Relances proactives avant les fêtes calendaires ----------
// Tourne chaque jour à 9h locale. Tant que le template Marketing WhatsApp
// n'est pas approuvé par Meta, sendReminderFn se contente de logger —
// voir lib/reminders.js pour le détail.
cron.schedule("0 9 * * *", async () => {
  const result = await runDailyReminderCheck(async (waId, text, occasion) => {
    // TODO : une fois le template Marketing approuvé par Meta, remplacer
    // ce log par un vrai appel de template (sendText ne fonctionne que si
    // l'utilisateur a écrit dans les dernières 24h, ce qui n'est pas garanti ici).
    console.log(`[Rappel ${occasion.label}] à envoyer à ${waId} : "${text}"`);
  });
  if (result.sent > 0) {
    console.log(`Rappels calendaires : ${result.sent} envoyé(s) pour ${result.occasions.join(", ")}`);
  }
});

app.listen(PORT, () => {
  console.log(`Serveur Wisheez à l'écoute sur le port ${PORT}`);
});
