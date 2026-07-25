/**
 * generate.js — transforme une spec collectée en conversation WhatsApp/web
 * en fichier vidéo prêt à être envoyé, en utilisant la VRAIE structure de
 * projet HyperFrames (découverte via `hyperframes init` + AGENTS.md + docs
 * CLI le 25/07/2026 — nos hypothèses initiales sur le format de composition
 * étaient fausses, ce fichier a été réécrit en conséquence).
 *
 * Chaque carte devient un vrai projet HyperFrames (dossier avec index.html,
 * hyperframes.json, meta.json), scaffoldé via `hyperframes init`, dans lequel
 * Claude écrit uniquement le contenu de la composition (pas le boilerplate).
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const PROJECTS_DIR = path.join(__dirname, "..", "compositions");
const MEDIA_DIR = path.join(__dirname, "..", "public", "media");
const STYLE_HISTORY_PATH = path.join(__dirname, "..", "data", "style-history.json");

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(STYLE_HISTORY_PATH), { recursive: true });

// ---------- Historique de styles (anti-répétition) ----------

function getRecentStyles(limit = 5) {
  if (!fs.existsSync(STYLE_HISTORY_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(STYLE_HISTORY_PATH, "utf-8")).slice(-limit);
  } catch {
    return [];
  }
}

function recordStyle(entry) {
  const history = getRecentStyles(50);
  history.push(entry);
  fs.writeFileSync(STYLE_HISTORY_PATH, JSON.stringify(history.slice(-50), null, 2), "utf-8");
}

function extractStyleComment(html) {
  const match = html.match(/<!--\s*traitement:.*?-->/i);
  return match ? match[0] : null;
}

// ---------- Prompt système : règles réelles de composition HyperFrames ----------

const HYPERFRAMES_RULES = `Tu écris le CONTENU d'une composition HyperFrames (pas le boilerplate — le
fichier index.html existe déjà avec le doctype, la balise <html>, le script GSAP
et le reset CSS). Tu dois fournir uniquement :

1. Le contenu à placer DANS la div #root (les éléments animés)
2. Le script d'animation GSAP à placer dans le <script> qui enregistre le timeline

Règles techniques obligatoires (vraie API HyperFrames, ne pas inventer d'autres conventions) :
- Chaque élément animé dans le temps DOIT avoir class="clip" + data-start="X" + data-duration="Y" + data-track-index="N"
- Le timeline GSAP doit être en pause et enregistré : window.__timelines["main"] = tl;
- Aucune logique non déterministe : pas de Date.now(), Math.random(), ni d'appel réseau
- Si une photo est fournie, utilise le placeholder <img src="{{PHOTO_SRC}}"> dans une balise <img class="clip" ...> — ne l'omets pas, ne l'invente pas

Réponds UNIQUEMENT avec un objet JSON de la forme :
{"rootContent": "<div class=\\"clip\\" data-start=\\"0\\" ...>...</div>...", "timelineScript": "tl.from('.titre', {...}, 0);..."}
Pas de markdown, pas de texte autour, juste le JSON.`;

const STYLE_LIBRARY = `
Règles de diversité visuelle — IMPORTANT :
Ne produis jamais deux fois la même disposition. Choisis et combine consciemment
parmi ces trois dimensions, en te basant sur les mots-clés de la demande plutôt
qu'au hasard :

TRAITEMENTS VISUELS (choisis-en un) :
- Médaillon : photo ronde/ovale encadrée, texte qui suit en dessous — bien pour mariage, portrait de couple
- Plein cadre : photo pleine page, effet Ken Burns (zoom lent via GSAP scale), texte superposé en bas — bien pour naissance, anniversaire
- Texte cinétique : pas de photo centrale, les mots apparaissent un à un, typographie qui bouge — bien pour félicitations sans photo
- Collage : plusieurs zones photo/texte qui s'assemblent successivement — bien pour mariage avec plusieurs personnes
- Carte à volets : une forme qui se déplie doucement pour révéler le message — passe-partout
- Carte-info : bloc structuré avec date/heure/lieu affichés clairement et lisiblement, fort contraste — OBLIGATOIRE pour les invitations

PALETTES (choisis-en une selon le ton décrit) :
- Ivoire & or (#F6EFE0 / #C9A227) : élégant, sobre
- Corail & rose (#E8B4AE / #D85A30) : festif, chaleureux
- Pastel doux : tendre, adapté aux naissances
- Émeraude profond (#1F3A2E) : solennel, mariage
- Vitaminé (jaune/turquoise) : joyeux, anniversaire enfant
- Noir & blanc + un accent : minimaliste, moderne

RYTHME D'ANIMATION (choisis-en un) :
- Lent et doux : émotion, mariage, naissance
- Dynamique : anniversaire, félicitations
- Épuré : peu de mouvement, beaucoup de respiration

RÈGLE SPÉCIFIQUE AUX INVITATIONS :
Si l'occasion est "Invitation", le champ "détails" contient des informations
pratiques (date, heure, lieu, tenue) — utilise le traitement "Carte-info" et
assure-toi que chaque information reste lisible au moins 2 secondes.

Indique ton choix en commentaire HTML en tout début du rootContent :
<!-- traitement: X, palette: Y, rythme: Z -->`;

async function callClaude(systemPrompt, userPrompt) {
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

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// ---------- Scaffolding du projet HyperFrames ----------

function initProject(projectId) {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });

  execSync(
    `npx hyperframes init "${projectId}" --example blank --non-interactive --resolution portrait`,
    { cwd: PROJECTS_DIR, stdio: "pipe", env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: "1" } }
  );
  return projectDir;
}

/** Injecte le contenu généré par Claude dans le index.html scaffoldé. */
function writeComposition(projectDir, rootContent, timelineScript, compositionVariables) {
  const indexPath = path.join(projectDir, "index.html");
  let html = fs.readFileSync(indexPath, "utf-8");

  // Injecter le contenu dans #root (juste avant la fermeture de la div)
  html = html.replace(
    /(<div\s+id="root"[^>]*>)([\s\S]*?)(<!--[\s\S]*?-->\s*<\/div>)/,
    (m, open, _old, closeComment) => `${open}\n${rootContent}\n    ${closeComment}`
  );

  // Injecter le script d'animation
  html = html.replace(
    /(const tl = gsap\.timeline\(\{ paused: true \}\);)([\s\S]*?)(window\.__timelines\["main"\] = tl;)/,
    (m, decl, _old, register) => `${decl}\n      ${timelineScript}\n      ${register}`
  );

  // Déclarer les variables de composition (pour les packs événement)
  if (compositionVariables) {
    html = html.replace(
      /<html lang="en" data-resolution="portrait">/,
      `<html lang="fr" data-resolution="portrait" data-composition-variables='${JSON.stringify(compositionVariables)}'>`
    );
  } else {
    html = html.replace(/<html lang="en"/, '<html lang="fr"');
  }

  fs.writeFileSync(indexPath, html, "utf-8");
  return indexPath;
}

function injectPhoto(indexPath, photoPath) {
  if (!photoPath || !fs.existsSync(photoPath)) return;
  const ext = path.extname(photoPath).slice(1) || "jpeg";
  const base64 = fs.readFileSync(photoPath).toString("base64");
  const dataUri = `data:image/${ext};base64,${base64}`;
  let html = fs.readFileSync(indexPath, "utf-8");
  html = html.replaceAll("{{PHOTO_SRC}}", dataUri);
  fs.writeFileSync(indexPath, html, "utf-8");
}

function lintProject(projectDir) {
  execSync(`npx hyperframes lint "${projectDir}"`, { stdio: "pipe" });
}

function renderProject(projectDir, outputPath, variables) {
  const varsFlag = variables ? `--variables '${JSON.stringify(variables)}'` : "";
  execSync(`npx hyperframes render "${projectDir}" ${varsFlag} -o "${outputPath}"`, {
    stdio: "pipe",
  });
  return outputPath;
}

// ---------- API publique ----------

/**
 * Génère une carte individuelle à partir d'une spec
 * { destinataire, occasion, details, photoPath? }.
 * Retourne le chemin absolu du fichier .mp4 rendu.
 */
async function generateCard(spec, cardId) {
  const recentStyles = getRecentStyles(5);
  const avoidLine = recentStyles.length
    ? `\nÉvite de reproduire ces combinaisons récemment utilisées : ${recentStyles.join(" | ")}`
    : "";

  const userPrompt = `Carte de vœux animée, 8 secondes, format portrait 1080x1920.
Destinataire : ${spec.destinataire}
Occasion : ${spec.occasion}
Ce que la personne veut exprimer : ${spec.details}
${spec.photoPath ? "Une photo est fournie : utilise {{PHOTO_SRC}} dans un traitement adapté." : "Aucune photo fournie : privilégie 'texte cinétique' ou 'carte à volets'."}${avoidLine}`;

  const { rootContent, timelineScript } = await callClaude(
    HYPERFRAMES_RULES + STYLE_LIBRARY,
    userPrompt
  );

  const styleComment = extractStyleComment(rootContent);
  if (styleComment) recordStyle(styleComment);

  const projectDir = initProject(cardId);
  const indexPath = writeComposition(projectDir, rootContent, timelineScript, null);
  injectPhoto(indexPath, spec.photoPath);
  lintProject(projectDir);

  const outputPath = path.join(MEDIA_DIR, `${cardId}.mp4`);
  return renderProject(projectDir, outputPath);
}

/**
 * Écrit UNE SEULE FOIS le projet de base d'une campagne (pack événement).
 * La composition déclare une variable "prenom" (data-composition-variables),
 * lue via window.__hyperframes.getVariables() — un seul appel à Claude pour
 * toute la campagne, quel que soit le nombre de destinataires.
 * Retourne le chemin du DOSSIER PROJET (pas un fichier).
 */
async function writeCampaignTemplate(spec, campaignId) {
  const userPrompt = `Carte de vœux animée pour un pack événement (plusieurs destinataires),
8 secondes, format portrait 1080x1920.
Occasion : ${spec.occasion}
Ce que le message doit exprimer : ${spec.details}
${spec.photoPath ? "Une photo est fournie (la même pour tous les destinataires) : utilise {{PHOTO_SRC}}." : "Aucune photo fournie."}

IMPORTANT : le prénom du destinataire varie à chaque rendu. Déclare une variable
de composition "prenom" (type string, default "Ami·e"), lis-la via
window.__hyperframes.getVariables() dans ton script, et injecte-la dans le texte
affiché (ex: un <span class="clip" id="prenom-invite"></span> dont tu fixes le
textContent au prénom lu).`;

  const { rootContent, timelineScript } = await callClaude(
    HYPERFRAMES_RULES + STYLE_LIBRARY,
    userPrompt
  );

  const styleComment = extractStyleComment(rootContent);
  if (styleComment) recordStyle(styleComment);

  const projectDir = initProject(`campaign-${campaignId}`);
  const compositionVariables = [
    { id: "prenom", type: "string", label: "Prénom du destinataire", default: "Ami·e" },
  ];
  const indexPath = writeComposition(projectDir, rootContent, timelineScript, compositionVariables);
  injectPhoto(indexPath, spec.photoPath);
  lintProject(projectDir);

  return projectDir;
}

/**
 * Rend la vidéo pour UN destinataire précis, à partir du projet déjà écrit
 * par writeCampaignTemplate(). Aucun nouvel appel à Claude ici — uniquement
 * le flag --variables natif de HyperFrames (calcul local, pas d'API payante).
 */
function renderCampaignRecipient(projectDir, recipientName, outputId) {
  const outputPath = path.join(MEDIA_DIR, `${outputId}.mp4`);
  return renderProject(projectDir, outputPath, { prenom: recipientName });
}

module.exports = { generateCard, writeCampaignTemplate, renderCampaignRecipient };
