/* ================================================================
   CONFIG
================================================================ */
const MAX_WORDS = 55;

/* ================================================================
   PALETTE — 4 niveaux selon la fréquence relative
================================================================ */
/** Rôle : Choisit une classe de couleur selon la fréquence d'un mot-clé. */
function pickColor(count, max) {
  const r = count / max;
  if (r >= 0.70) return "#9b1c1c";   // très fréquent — rouge très foncé
  if (r >= 0.40) return "#c0392b";   // fréquent     — rouge foncé
  if (r >= 0.18) return "#e57373";   // moyen        — rouge clair
  return "#2c3e50";                   // moins fréquent — gris bleu
}

/* ================================================================
   HELPERS
================================================================ */
/** Rôle : Supprime les accents afin de rendre les recherches textuelles plus robustes. */
function stripAccents(v) {
  return String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
/** Rôle : Convertit une valeur simple ou séparée par des délimiteurs en tableau nettoyé. */
function toArray(v) {
  return Array.isArray(v) ? v : String(v || "").split(/[;,]/).map(x => x.trim()).filter(Boolean);
}
/** Rôle : Écarte les termes techniques ou non pertinents du nuage de mots. */
function isForbiddenCloudTerm(term) {
  const k = stripAccents(String(term || "").toLowerCase())
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9_ -]+/g, " ")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  // Supprime définitivement toutes les variantes :
  // non_classe, non_classé, Non classé, Non_classé, etc.
  return k === "non_classe" || k.startsWith("non_classe_") || /^non_?classe/.test(k);
}
const STOPWORDS = new Set(["a","à","afin","au","avec","ce","ces","dans","de","des","du","elle","en","est","et","il","je","la","le","les","leur","mais","ne","ou","par","pas","pour","que","qui","sa","se","si","son","sur","un","une","non","classe","classé","classee","non_classe","non_classé","non_classee","donnée","données","jeu","dataset","fichier","format","source","url","api","csv","json","geojson","zip","xlsx","pdf","xml","open","data","toulouse","metropole","métropole","opendata","id","nom","type","valeur","champ","table","code","lien","jumeau","numérique","urbain","dd","mm","yy","yyyy","hh","heure","minute","minutes","libelle","libellé","renseigne","renseigné","maj","att","dep","quart","pop_h","pop_f"]);
const TECHNICAL_PATTERNS = [
  /^(dd|mm|yy|yyyy|hh|mn|ss)([_-](dd|mm|yy|yyyy|hh|mn|ss))*$/i,
  /^d[_-]?heure$/i,
  /^d[_-]?minute/i,
  /^dd[_-]?mm[_-]?yy/i,
  /^mm[_-]?dd[_-]?yy/i,
  /^type[_-]?de[_-]?station$/i,
  /^code[_-]?insee$/i,
  /^act\w*1564$/i,
  /^actocc\w*1564$/i,
  /^appart$/i,
  /^agriculteurs?$/i
];
const EXACT_MAP = {"transport":"Transport","mobilite":"Mobilité","mobilité":"Mobilité","mobilite_douce":"Mobilité douce","mobilité_douce":"Mobilité douce","localisation":"Localisation","geolocalisation":"Géolocalisation","géolocalisation":"Géolocalisation","geopoint":"GeoPoint","geo_point":"GeoPoint","geopoint_2d":"GeoPoint","geoshape":"GeoShape","geo_shape":"GeoShape","station_meteo":"station_meteo","station_météo":"station_meteo","iris":"IRIS","velotoulouse":"VélôToulouse","velôtoulouse":"VélôToulouse","batiment":"Bâtiment","bâtiment":"Bâtiment","environnement":"Environnement","population":"Population","infrastructure":"Infrastructure","velo":"Vélo","vélo":"Vélo","energie":"Énergie","énergie":"Énergie","electricite":"Électricité","temperature":"Température","température":"Température","precipitation":"Précipitation","précipitation":"Précipitation","deplacement":"Déplacement","déplacement":"Déplacement","arret":"Arrêt","arrêt":"Arrêt","pieton":"Piéton","piéton":"Piéton","chomage":"Chômage","chômage":"Chômage","logement":"Logement","menage":"Ménage","ménage":"Ménage","education":"Éducation","diplome":"Diplôme","diplôme":"Diplôme","frequence":"Fréquence","fréquence":"Fréquence","meteo":"Météo","météo":"Météo","demographie":"Démographie","recensement":"Recensement"};

/** Rôle : Normalise le nom d'une thématique pour son regroupement. */
function normalizeTheme(v) {
  const r = stripAccents(String(v || "").toLowerCase()).trim();
  if (r.includes("transport"))    return "Transport";
  if (r.includes("environnement"))return "Environnement";
  if (r.includes("population"))   return "Population";
  if (r.includes("espace"))       return "Espaces publics";
  if (r.includes("batiment") || r.includes("bâtiment")) return "Bâtiment";
  if (r.includes("technologie"))  return "Technologie";
  return "Autres";
}

/** Rôle : Normalise la clé d'un sous-ensemble de mots-clés. */
function normalizeGroupKey(value) {
  return stripAccents(String(value || "").toLowerCase())
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

const KEYWORD_GROUPS = [
  { label: "Localisation", members: ["localisation", "geopoint", "geo_point", "geopoint_2d", "geoshape", "geo_shape"] },
  { label: "Météo", members: ["meteo", "météo", "station_meteo", "station_météo"] },
  { label: "Mobilité douce", members: ["mobilite_douce", "mobilité_douce", "velo", "vélo", "velotoulouse", "velôtoulouse"] },
  { label: "Quartier", members: ["quartier", "quartiers", "grand_quartier", "grands_quartiers", "iris", "avenue", "rue", "boulevard", "place", "impasse", "chemin", "secteur", "secteurs"] },
  { label: "Éducation", members: ["education", "éducation", "ecole", "école", "ecoles", "écoles", "scolaire", "scolaires", "diplome", "diplôme", "diplomes", "diplômes", "maternelle", "maternelles", "etablissement", "établissement", "etablissements", "établissements"] },
  { label: "Espace public", members: ["espace_public", "espaces_publics", "espace public", "espaces publics"] }
].map(group => ({
  label: group.label,
  memberKeys: new Set(group.members.map(normalizeGroupKey))
}));

/** Rôle : Ajoute les sous-ensembles thématiques correspondant aux mots-clés détectés. */
function applyKeywordGroups(termsSet) {
  KEYWORD_GROUPS.forEach(group => {
    const hasGroupMember = [...termsSet].some(term => group.memberKeys.has(normalizeGroupKey(term)));
    if (!hasGroupMember) return;
    [...termsSet].forEach(term => {
      if (group.memberKeys.has(normalizeGroupKey(term))) termsSet.delete(term);
    });
    termsSet.add(group.label);
  });
}

/* ================================================================
   BUILD WORD FREQUENCY MAP
================================================================ */
/** Rôle : Calcule les fréquences des mots-clés et construit les données du nuage. */
function buildWordMap() {
  const datasets = window.SAMPLE_DATASETS || [];
  const map = {};

  const normalizeDisplay = (term) => {
    if (isForbiddenCloudTerm(term)) return "";
    const k = stripAccents(String(term || "").toLowerCase())
      .replace(/[’']/g, " ")
      .replace(/[^a-z0-9_ -]+/g, " ")
      .replace(/[\s-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    if (isForbiddenCloudTerm(k)) return "";
    if (TECHNICAL_PATTERNS.some(rx => rx.test(k))) return "";
    if (STOPWORDS.has(k) || k.length < 3) return "";

    const display = EXACT_MAP[k] || String(term).charAt(0).toUpperCase() + String(term).slice(1);
    if (isForbiddenCloudTerm(display)) return "";
    return display;
  };

  const groupDatasetCounts = new Map(KEYWORD_GROUPS.map(group => [group.label, 0]));

  datasets.forEach(d => {
    // IMPORTANT : on compte 1 occurrence maximum par dataset.
    // Même si le même mot apparaît dans les tags, le titre et le thème,
    // il est ajouté une seule fois pour ce dataset grâce au Set.
    const termsInThisDataset = new Set();

    toArray(d.tags).forEach(t => {
      const display = normalizeDisplay(t);
      if (display) termsInThisDataset.add(display);
    });

    String(d.title || d.nom || "").split(/\s+/).forEach(w => {
      const clean = w.replace(/[^a-zA-ZÀ-ÿ_-]/g, "");
      const display = normalizeDisplay(clean);
      if (display) termsInThisDataset.add(display);
    });

    const theme = normalizeTheme(d.theme || d.thematique || d.category || "");
    if (theme && theme !== "Autres") {
      const display = normalizeDisplay(theme);
      if (display) termsInThisDataset.add(display);
    }

    // Comptage des mots simples : une occurrence maximum par dataset.
    termsInThisDataset.forEach(term => {
      map[term] = (map[term] || 0) + 1;
    });

    // Comptage des six sous-ensembles par UNION : un dataset contribue une
    // seule fois au parent, même s'il contient plusieurs mots membres.
    // Sous-ensembles : recherche dans TOUT le dataset (titre, tags, description,
    // métadonnées et attributs). Cela reproduit la règle du catalogue :
    // membre 1 OU membre 2 OU ... avec un seul comptage par dataset.
    const groupHaystack = `_${stripAccents(JSON.stringify(d || {}).toLowerCase())
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")}_`;
    KEYWORD_GROUPS.forEach(group => {
      const matchesGroup = [...group.memberKeys].some(memberKey =>
        groupHaystack.includes(`_${memberKey}_`)
      );
      if (matchesGroup) {
        groupDatasetCounts.set(group.label, (groupDatasetCounts.get(group.label) || 0) + 1);
      }
    });
  });

  // Les membres sont masqués dans le nuage au profit du libellé parent.
  KEYWORD_GROUPS.forEach(group => {
    Object.keys(map).forEach(term => {
      if (group.memberKeys.has(normalizeGroupKey(term)) && term !== group.label) delete map[term];
    });
    const total = groupDatasetCounts.get(group.label) || 0;
    if (total > 0) map[group.label] = total;
  });

  return map;
}

/* ================================================================
   RENDER with d3-cloud
================================================================ */
let selected = [];
let allWords = [];

/** Rôle : Normalise une valeur sélectionnée pour la comparer aux mots-clés du catalogue. */
function normalizeSelectionKey(value) {
  return stripAccents(String(value || "").toLowerCase())
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
const SELECTION_EXPANSIONS = {
  localisation: ["Localisation", "GeoPoint", "GeoShape"],
  meteo: ["Météo", "station_meteo"],
  mobilite_douce: ["Mobilité douce", "Vélo", "VélôToulouse"],
  quartier: ["Quartier", "IRIS", "Avenue", "Rue", "Boulevard", "Place", "Impasse", "Chemin", "grands_quartiers"],
  education: ["Éducation", "École", "Scolaire", "Diplôme", "Maternelle", "Établissement"],
  espace_public: ["Espace public", "espaces_publics"]
};

/** Rôle : Développe les sous-ensembles sélectionnés en mots-clés réellement recherchés. */
function expandSelectionForCatalog(values) {
  const expanded = [];
  const add = (value) => {
    if(value && !expanded.includes(value)) expanded.push(value);
  };
  (Array.isArray(values) ? values : []).forEach(value => {
    const key = normalizeSelectionKey(value);
    const group = SELECTION_EXPANSIONS[key];
    if(group) group.forEach(add);
    else add(value);
  });
  return expanded;
}

/** Rôle : Construit l'affichage complet du diagnostic spatial reçu du serveur. */
function render() {
  const wrap = document.getElementById("cloudWrap");
  const W = wrap.clientWidth || 900;
  const H = Math.max(520, Math.round(W * 0.58));

  const svg = d3.select("#cloudSvg")
    .attr("width", W)
    .attr("height", H)
    .attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  const map = buildWordMap();
  Object.keys(map).forEach(key => {
    if (isForbiddenCloudTerm(key)) delete map[key];
  });
  let entries = Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_WORDS);


  const maxCount = entries[0]?.[1] || 1;
  const minCount = entries[entries.length - 1]?.[1] || 1;

  // Font size: log scale so huge outliers don't dominate
  const sizeScale = d3.scaleLog()
    .domain([Math.max(1, minCount), Math.max(1, maxCount)])
    .range([13, 68])
    .clamp(true);

  allWords = entries.map(([text, count]) => ({
    text,
    count,
    size: sizeScale(count),
    color: pickColor(count, maxCount),
  }));

  document.getElementById("totalWords").textContent = allWords.length;

  // d3-cloud layout
  d3.layout.cloud()
    .size([W, H])
    .words(allWords.map(w => ({ ...w })))
    .padding(3)                          // tight but not overlapping
    .rotate(() => 0)                     // all horizontal — like reference image
    .font("Arial")
    .fontWeight("800")
    .fontSize(d => d.size)
    .spiral("archimedean")
    .on("end", draw)
    .start();

  /** Rôle : Dessine le nuage de mots interactif à partir des fréquences calculées. */
  function draw(cloudWords) {
    const g = svg.append("g")
      .attr("transform", `translate(${W / 2},${H / 2})`);

    g.selectAll("text")
      .data(cloudWords)
      .enter().append("text")
        .attr("class", d => "wc-word" + (selected.includes(d.text) ? " sel" : ""))
        .style("font-size", d => d.size + "px")
        .style("font-family", "Arial, sans-serif")
        .style("font-weight", "800")
        .style("fill", d => selected.includes(d.text) ? "#0b2b66" : d.color)
        .attr("text-anchor", "middle")
        .attr("transform", d => `translate(${d.x},${d.y})rotate(${d.rotate})`)
        .text(d => d.text)
        .on("click", function(event, d) {
          if (selected.includes(d.text)) selected = selected.filter(w => w !== d.text);
          else selected.push(d.text);
          try { localStorage.setItem("selectedCloudKeywords", JSON.stringify(selected)); } catch(e) {}
          render();
        })
        .on("mouseenter", function(event, d) {
          const tip = document.getElementById("wcTip");
          tip.textContent = `${d.text} — ${d.count} occurrence${d.count > 1 ? "s" : ""}`;
          tip.style.display = "block";
        })
        .on("mousemove", function(event) {
          const tip = document.getElementById("wcTip");
          tip.style.left = (event.clientX + 14) + "px";
          tip.style.top  = (event.clientY - 30) + "px";
        })
        .on("mouseleave", function() {
          document.getElementById("wcTip").style.display = "none";
        });

    renderSelBar();
  }
}

/** Rôle : Met à jour la barre des mots-clés actuellement sélectionnés. */
function renderSelBar() {
  document.getElementById("selectedCount").textContent = selected.length;
  const label = document.getElementById("selLabel");
  const chips = document.getElementById("selChips");
  label.style.display = selected.length ? "" : "none";
  chips.innerHTML = selected.map(w =>
    `<button class="sel-chip" data-r="${w}">${w} <span style="opacity:.7">×</span></button>`
  ).join("");
  chips.querySelectorAll("[data-r]").forEach(btn => btn.onclick = () => {
    selected = selected.filter(w => w !== btn.dataset.r);
    try { localStorage.setItem("selectedCloudKeywords", JSON.stringify(selected)); } catch(e) {}
    render();
  });
}

/* ================================================================
   INIT
================================================================ */
document.getElementById("resetBtn").onclick = () => {
  selected = [];
  try { localStorage.removeItem("selectedCloudKeywords"); } catch(e) {}
  render();
};
document.getElementById("confirmBtn").onclick = () => {
  try { localStorage.setItem("selectedCloudKeywords", JSON.stringify(expandSelectionForCatalog(selected))); } catch(e) {}
  window.location.href = "/";
};

try { selected = expandSelectionForCatalog(JSON.parse(localStorage.getItem("selectedCloudKeywords") || "[]")); } catch(e) { selected = []; }

// Re-render on resize
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 250);
});

render();