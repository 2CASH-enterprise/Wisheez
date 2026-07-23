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

fs.mkdirSync(COMPOSITIONS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

async function writeComposition(spec, cardId) {
  const systemPrompt = `Tu génères des compositions HTML valides pour HyperFrames (framework HeyGen).
Règles obligatoires :
- Utilise les attributs data-* pour le timing (data-start, data-duration)
- Chaque scène doit avoir class="clip"
- Le contenu visuel va dans un wrapper .scene-content
- Utilise GSAP pour les animations d'entrée
- Ton élégant et chaleureux, adapté à l'occasion précisée
- Réponds UNIQUEMENT avec le code HTML complet, sans markdown, sans explication.`;

  const userPrompt = `Génère une carte de vœux animée HyperFrames.
Destinataire : ${spec.destinataire}
Occasion : ${spec.occasion}
Ce que la personne veut exprimer : ${spec.details}
Durée : 8 secondes
Format : 1080x1920 (vertical, pour WhatsApp)`;

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

/**
 * Génère une carte à partir d'une spec { destinataire, occasion, details }.
 * Retourne le chemin absolu du fichier .mp4 rendu.
 */
async function generateCard(spec, cardId) {
  const htmlPath = await writeComposition(spec, cardId);
  const videoPath = lintAndRender(htmlPath, cardId);
  return videoPath;
}

module.exports = { generateCard };
