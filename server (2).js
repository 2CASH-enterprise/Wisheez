require("dotenv").config();

const express = require("express");
const path = require("path");
const { getUser, updateUser, hasFreeCardLeft } = require("./lib/store");
const { sendText, sendVideo, markAsRead, parseIncomingMessage } = require("./lib/whatsapp");
const { generateCard } = require("./lib/generate");

const app = express();
app.use(express.json());

// Sert les vidéos générées à une URL publique, ex :
// https://votredomaine.com/media/abc123.mp4 — c'est ce lien qu'on donne à WhatsApp.
app.use("/media", express.static(path.join(__dirname, "public", "media")));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // ex: https://wisheez.votredomaine.com

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

// ---------- 3. Logique de conversation ----------
async function handleMessage(incoming) {
  const { waId, text } = incoming;
  const user = getUser(waId);

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
      const CARD_PRICE_CENTS = 299;

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

app.listen(PORT, () => {
  console.log(`Serveur Wisheez à l'écoute sur le port ${PORT}`);
});
