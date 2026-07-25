/**
 * calendar.js — les fêtes calendaires à surveiller pour les relances proactives.
 *
 * `leadDays` = combien de jours avant la date on envoie le rappel.
 * Les dates sont au format { month, day } et se répètent chaque année
 * (sauf Pâques, dont la date change — voir calculateEaster ci-dessous).
 */

const OCCASIONS = [
  {
    id: "noel",
    label: "Noël",
    month: 12,
    day: 25,
    leadDays: 12,
    palette: "Rouge profond, vert sapin, or",
    messageHint: "Envoyez vos vœux de fin d'année avant que tout le monde soit débordé.",
  },
  {
    id: "nouvel-an",
    label: "Nouvel An",
    month: 1,
    day: 1,
    leadDays: 4,
    palette: "Noir & or, effet confettis",
    messageHint: "Souhaitez une belle nouvelle année à vos proches.",
  },
  {
    id: "saint-valentin",
    label: "Saint-Valentin",
    month: 2,
    day: 14,
    leadDays: 5,
    palette: "Rouge, rose poudré, bordeaux",
    messageHint: "Un mot doux, en vidéo, pour la personne que vous aimez.",
  },
  {
    id: "halloween",
    label: "Halloween",
    month: 10,
    day: 31,
    leadDays: 6,
    palette: "Orange brûlé, violet profond, noir",
    messageHint: "Une carte un brin joueuse pour Halloween.",
  },
  {
    id: "fete-des-meres",
    label: "Fête des mères",
    month: 5,
    day: 26, // à ajuster chaque année (dernier dimanche de mai en France) — voir note plus bas
    leadDays: 6,
    palette: "Pastel doux",
    messageHint: "Dites-lui merci, en vidéo.",
  },
];

/** Calcule la date de Pâques (algorithme de Meeus/Jones/Butcher), ajoutée dynamiquement. */
function calculateEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/**
 * Retourne la liste des occasions avec leur prochaine date calendaire résolue
 * (en tenant compte du fait qu'on a peut-être déjà dépassé la date cette année).
 */
function getOccasionsWithNextDate(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const easter = calculateEaster(year);

  const all = [
    ...OCCASIONS,
    {
      id: "paques",
      label: "Pâques",
      month: easter.month,
      day: easter.day,
      leadDays: 6,
      palette: "Pastel (jaune poussin, vert tendre, lilas)",
      messageHint: "Un petit mot printanier pour Pâques.",
    },
  ];

  return all.map((occ) => {
    let nextDate = new Date(year, occ.month - 1, occ.day);
    if (nextDate < referenceDate) {
      nextDate = new Date(year + 1, occ.month - 1, occ.day);
    }
    return { ...occ, nextDate };
  });
}

module.exports = { OCCASIONS, getOccasionsWithNextDate, calculateEaster };
