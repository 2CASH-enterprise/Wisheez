/**
 * generate.js — transforme une spec collectée en conversation WhatsApp
 * en fichier vidéo prêt à être envoyé.
 *
 * Reprend le même principe que le script batch-generate-videos.js déjà
 * préparé : Claude écrit la composition HyperFrames, la CLI hyperframes
 * la valide (lint) puis la rend (render).
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const COMPOSITIONS_DIR = path.join(__dirname, "..", "compositions");
const MEDIA_DIR = path.join(__dirname, "..", "public", "media");
const STYLE_HISTORY_PATH = path.join(__dirname, "..", "data", "style-history.json");

fs.mkdirSync(COMPOSITIONS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(STYLE_HISTORY_PATH), { recursive: true });

function getRecentStyles(limit = 5) {
  if (!fs.existsSync(STYLE_HISTORY_PATH)) return [];
  try {
    const history = JSON.parse(fs.readFileSync(STYLE_HISTORY_PATH, "utf-8"));
    return history.slice(-limit);
  } catch {
    return [];
  }
}

function recordStyle(entry) {
  const history = getRecentStyles(50);
  history.push(entry);
  fs.writeFileSync(STYLE_HISTORY_PATH, JSON.stringify(history.slice(-50), null, 2), "utf-8");
}

/** Extrait la ligne <!-- traitement: X, palette: Y, rythme: Z --> écrite par Claude en tête de fichier. */
function extractStyleComment(html) {
  const match = html.match(/<!--\s*traitement:.*?-->/i);
  return match ? match[0] : null;
}

async function writeComposition(spec, cardId) {
  const systemPrompt = `Tu génères des compositions HTML valides pour HyperFrames (framework HeyGen).

Règles techniques obligatoires :
- Utilise les attributs data-* pour le timing (data-start, data-duration)
- Chaque scène doit avoir class="clip"
- Le contenu visuel va dans un wrapper .scene-content
- Utilise GSAP pour les animations d'entrée
- Si une photo est fournie, utilise le placeholder <img src="{{PHOTO_SRC}}"> — ne l'omets pas, ne l'invente pas
- Si le champ "Destinataire" contient exactement le texte {{PRENOM_INVITE}}, c'est un template pour plusieurs destinataires : recopie ce placeholder littéralement dans le texte affiché (ex. "Merci {{PRENOM_INVITE}} !"), ne le remplace par aucun prénom
- Réponds UNIQUEMENT avec le code HTML complet, sans markdown, sans explication

Règles de diversité visuelle — IMPORTANT :
Ne produis jamais deux fois la même disposition. Choisis et combine consciemment
parmi ces trois dimensions, en te basant sur les mots-clés de la demande plutôt
qu'au hasard :

TRAITEMENTS VISUELS (choisis-en un) :
- Médaillon : photo ronde/ovale encadrée, texte qui suit en dessous — bien pour mariage, portrait de couple
- Plein cadre : photo pleine page, effet Ken Burns (zoom lent), texte superposé en bas sur un léger dégradé — bien pour naissance, anniversaire
- Texte cinétique : pas de photo centrale, les mots apparaissent un à un, typographie qui bouge — bien pour félicitations sans photo
- Collage : plusieurs zones photo/texte qui s'assemblent successivement — bien pour mariage avec plusieurs personnes
- Carte à volets : une forme qui se déplie doucement pour révéler le message, comme une carte qu'on ouvre — passe-partout

PALETTES (choisis-en une selon le ton décrit par l'utilisateur) :
- Ivoire & or (#F6EFE0 / #C9A227) : élégant, sobre
- Corail & rose (#E8B4AE / #D85A30) : festif, chaleureux
- Pastel doux : tendre, adapté aux naissances
- Émeraude profond (#1F3A2E) : solennel, mariage
- Vitaminé (jaune/turquoise) : joyeux, anniversaire enfant
- Noir & blanc + un accent : minimaliste, moderne

RYTHME D'ANIMATION (choisis-en un selon l'émotion recherchée) :
- Lent et doux : émotion, mariage, naissance
- Dynamique : anniversaire, félicitations
- Épuré : peu de mouvement, beaucoup de respiration

Justifie ton choix en un commentaire HTML en tout début de fichier
(<!-- traitement: X, palette: Y, rythme: Z -->) pour qu'on puisse suivre la variété dans le temps.`;

  const recentStyles = getRecentStyles(5);
  const avoidLine = recentStyles.length
    ? `\nÉvite de reproduire ces combinaisons récemment utilisées : ${recentStyles.join(" | ")}`
    : "";

  const userPrompt = `Génère une carte de vœux animée HyperFrames.
Destinataire : ${spec.destinataire}
Occasion : ${spec.occasion}
Ce que la personne veut exprimer : ${spec.details}
${spec.photoPath ? "Une photo est fournie : utilise le placeholder {{PHOTO_SRC}} dans un traitement adapté." : "Aucune photo fournie : privilégie le traitement 'texte cinétique' ou 'carte à volets'."}
Durée : 8 secondes
Format : 1080x1920 (vertical, pour WhatsApp)${avoidLine}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erreur API Claude (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Réponse Claude sans contenu texte");

  const html = textBlock.text.replace(/```html|```/g, "").trim();
  const htmlPath = path.join(COMPOSITIONS_DIR, `${cardId}.html`);
  fs.writeFileSync(htmlPath, html, "utf-8");

  const styleComment = extractStyleComment(html);
  if (styleComment) recordStyle(styleComment);

  return htmlPath;
}

function lintAndRender(htmlPath, cardId) {
  execSync(`npx hyperframes lint "${htmlPath}"`, { stdio: "pipe" });

  const outPath = path.join(MEDIA_DIR, `${cardId}.mp4`);
  execSync(`npx hyperframes render "${htmlPath}" --output "${outPath}"`, {
    stdio: "pipe",
  });
  return outPath;
}

/** Remplace {{PHOTO_SRC}} par l'image encodée en base64, si une photo a été fournie. */
function injectPhoto(htmlPath, photoPath) {
  if (!photoPath || !fs.existsSync(photoPath)) return;
  const ext = path.extname(photoPath).slice(1) || "jpeg";
  const base64 = fs.readFileSync(photoPath).toString("base64");
  const dataUri = `data:image/${ext};base64,${base64}`;

  let html = fs.readFileSync(htmlPath, "utf-8");
  html = html.replaceAll("{{PHOTO_SRC}}", dataUri);
  fs.writeFileSync(htmlPath, html, "utf-8");
}

/**
 * Génère une carte à partir d'une spec { destinataire, occasion, details, photoPath? }.
 * Retourne le chemin absolu du fichier .mp4 rendu.
 */
async function generateCard(spec, cardId) {
  const htmlPath = await writeComposition(spec, cardId);
  injectPhoto(htmlPath, spec.photoPath);
  const videoPath = lintAndRender(htmlPath, cardId);
  return videoPath;
}

/**
 * Écrit UNE SEULE FOIS le template de base d'une campagne (pack événement).
 * Contrairement à generateCard, le nom du destinataire n'est pas fixé ici —
 * Claude utilise le placeholder {{PRENOM_INVITE}}, remplacé individuellement
 * pour chaque destinataire par renderCampaignRecipient(). C'est ce qui permet
 * un seul appel à Claude pour toute la campagne, quel que soit le nombre
 * de destinataires (voir lib/campaigns.js pour la tarification associée).
 */
async function writeCampaignTemplate(spec, campaignId) {
  const templateSpec = { ...spec, destinataire: "{{PRENOM_INVITE}}" };
  const htmlPath = await writeComposition(templateSpec, `campaign-${campaignId}`);
  injectPhoto(htmlPath, spec.photoPath); // la photo est la même pour tous les destinataires
  return htmlPath;
}

/**
 * Rend la vidéo pour UN destinataire précis, à partir du template déjà écrit
 * par writeCampaignTemplate(). Aucun nouvel appel à Claude ici — uniquement
 * un remplacement de texte suivi d'un rendu HyperFrames (calcul local).
 */
function renderCampaignRecipient(templateHtmlPath, recipientName, outputId) {
  const recipientHtmlPath = path.join(COMPOSITIONS_DIR, `${outputId}.html`);
  let html = fs.readFileSync(templateHtmlPath, "utf-8");
  html = html.replaceAll("{{PRENOM_INVITE}}", recipientName);
  fs.writeFileSync(recipientHtmlPath, html, "utf-8");
  return lintAndRender(recipientHtmlPath, outputId);
}

module.exports = { generateCard, writeCampaignTemplate, renderCampaignRecipient };
