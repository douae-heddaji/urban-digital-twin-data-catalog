const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzHJJUeJXdHcTOiDyAtBnZ1eQsyR4IgWpbW2mFK_9Vv7WtG9_tStrYhCRQ2reJy9hlMYA/exec";
const GOOGLE_SHEET_ID = "1hlZBcHTi2NvcqdmKnrUqhuyJnW_ls0TUOxNPkHEl6dc";

let datasets = Array.isArray(window.SAMPLE_DATASETS) ? window.SAMPLE_DATASETS : [];
let cloudItems = [];
let cloudThemeItems = [];
let selectedCloudKeywords = [];
let cloudSortValue = "size";

const $ = id => document.getElementById(id);

/** Rôle : Supprime les accents afin de rendre les recherches textuelles plus robustes. */
function stripAccents(value){
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
/** Rôle : Échappe les caractères HTML afin d'éviter une insertion non sûre. */
function escapeHtml(value){
  return String(value ?? "").replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
/** Rôle : Convertit différents formats de date en objet Date JavaScript. */
function parseDate(value){
  if(!value) return null;
  if(value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value).trim();
  if(!raw || /^non renseign/i.test(raw)) return null;
  if(["PRESENT","PRÉSENT","PRESENTE","PRÉSENTE"].includes(raw.toUpperCase())) return new Date();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(iso) return new Date(Number(iso[1]), Number(iso[2])-1, Number(iso[3]));
  const fr = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(fr) return new Date(Number(fr[3]), Number(fr[2])-1, Number(fr[1]));
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** Rôle : Convertit une date valide au format ISO utilisé pour les comparaisons. */
function dateToIso(d){
  if(!d) return "0000-00-00";
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
/** Rôle : Normalise la date de dernière modification d'un jeu de données. */
function normalizeLastModified(value){ return dateToIso(parseDate(value)); }
/** Rôle : Convertit une valeur simple ou séparée par des délimiteurs en tableau nettoyé. */
function toArray(v){ return Array.isArray(v) ? v : String(v || "").split(/[;,]/).map(x=>x.trim()).filter(Boolean); }

const CLOUD_SHORT_KEEP = new Set(["eau","air","bus","lac","sol","rue","gaz"]);
const CLOUD_PROTECTED_TERMS = new Set(["GeoPoint","GeoShape","code_insee","code_postal","grands_quartiers","pech_david","basso_cambo","mobilité_douce"]);
const CLOUD_DOMAIN_TERMS = new Set([
  "transport","mobilité","mobilité_douce","déplacement","circulation","trafic","comptage","piéton","vélo","cycle","cyclable","bus","tram","métro","tisséo","itinéraire","ligne","arrêt","station","taxi","voiture","parking","stationnement","route","rue","voie","voirie","borne","recharge","électrique",
  "environnement","météo","climat","température","humidité","précipitation","pluie","vent","pression","air","eau","énergie","électricité","bruit","pollution","ozone","particule","arbre","jardin","parc","espace_vert","nature","risque","inondation","déchet","serre",
  "population","recensement","logement","ménage","famille","emploi","chômage","inactivité","activité","éducation","diplôme","revenu","santé","âge","sexe","habitant","naissance","décès","immigration",
  "bâtiment","infrastructure","équipement","commerce","service","adresse","commune","quartier","iris","territoire","localisation","géolocalisation","géométrie","GeoPoint","GeoShape","code_insee","code_postal","longitude","latitude",
  "archive","grand_quartier","grands_quartiers","pech_david","basso_cambo","aire","public","publique","secteur","postal"
]);
const CLOUD_STOPWORDS = new Set([
  "a","à","afin","ai","ainsi","alors","au","aucun","aucune","aussi","autre","aux","avec","avoir","ce","ces","cet","cette","chez","comme","comment","dans","de","des","du","elle","elles","en","encore","entre","est","et","etre","être","eux","fait","faire","il","ils","je","la","le","les","leur","leurs","lors","mais","mes","mon","ne","nos","notre","nous","ou","où","par","pas","peu","plus","pour","qu","que","quel","quelle","qui","sa","sans","se","ses","si","son","sont","sur","ta","tes","ton","tous","tout","toute","toutes","tu","un","une","vos","votre","vous",
  "non","renseigné","renseigne","donnée","données","donnee","donnees","jeu","jeux","dataset","datasets","fichier","fichiers","format","formats","source","sources","url","api","csv","json","geojson","zip","xlsx","xls","pdf","xml","parquet","gpkg","shp","kml","html","http","https","www","com","fr","open","data","toulouse","metropole","métropole","opendata",
  "alimenter","jumeau","classe","classé","non_classe","non_classé","att","attribut","attributs","quart","code","frd","grd","dma","python","life","no2","id","nom","type","valeur","valeurs","champ","champs","colonne","colonnes","table","tables","fiche","base","projet","urbain","numerique","numérique","lien","liens","partir","peut","telecharge","téléchargé","telecharger","télécharger","telechargement","téléchargement","sot","annees","heure","heures","minute","minutes","jour","jours","mois","don","dont","utilise","utilisé","utiliser","permet","permettre","doit","voir","liée","lie","liés","liées","lié",
  "meteopole","météopole","latitude","lat","longitude","lon","long","meme","même","mons","pty","basemap","jawg","activite_copie","activitecopie","copie","jory","juin","janvier","fevrier","février","mars","avril","mai","juillet","aout","août","septembre","octobre","novembre","decembre","décembre","salade","david","soupetard","nakache","labo","test","exemple","divers","inconnu","inconnue","inconnus","null","nul","na","n_a","sans_objet","autre","autres","basso","cambo","maj","hebdomadaire","mensuel","mensuelle","mensuelles","quotidien","quotidienne","annuel","annuelle","chaque","renseigne","renseigné","renseignement","renseignements","libelle","libellé","libelles","libellés","identifiant","identifiants","description","descriptions","periode","période","periodes","périodes","frequence","fréquence","frequences","fréquences","periodicite","périodicité","minute","minutes","heure","heures","quart_heure","quart_d_heure","15_minutes","departement","département","objectid","fid","gid","uuid","shape","shape_area","shape_length","coord","coordonnees","coordonnées","ylat","xlong","altitude","no","lib_voie","street","street_name","name","code_postal","postal","insee","act1564","actocc1564","agriculteur","agriculteurs","appart","production"
]);
const CLOUD_EXACT_MAP = {
  "chom1564":"chômage", "chomage":"chômage", "chomages":"chômage", "chomeur":"chômage", "chomeurs":"chômage",
  "inactive1564":"inactivité", "inactive":"inactivité", "inactives":"inactivité", "inactif":"inactivité", "inactifs":"inactivité", "inactivite":"inactivité",
  "pop1564":"population", "population1564":"population", "p20_pop":"population", "pop":"population",
  "nb_logt":"logement", "logt":"logement", "logts":"logement", "logement":"logement", "logements":"logement",
  "menage":"ménage", "menages":"ménage", "ménages":"ménage",
  "emploi1564":"emploi", "actif1564":"emploi", "actifs":"emploi",
  "temp":"température", "temperature":"température", "temperatures":"température", "temp_moy":"température", "tempmin":"température", "tempmax":"température",
  "humidite":"humidité", "humidité":"humidité", "hum":"humidité",
  "precip":"précipitation", "precipitation":"précipitation", "precipitations":"précipitation", "pluie":"précipitation",
  "pression_mer":"pression", "pressionmer":"pression",
  "energie":"énergie", "energies":"énergie", "electricite":"électricité", "electricites":"électricité", "electrique":"électrique", "electriques":"électrique",
  "annee":"année", "annees":"année",
  "transport":"transport", "transports":"transport", "tranport":"transport", "tranports":"transport",
  "mobilite":"mobilité", "mobilites":"mobilité", "mobilite_douce":"mobilité_douce", "mobilites_douces":"mobilité_douce",
  "activite":"activité", "activites":"activité", "activité":"activité", "activités":"activité",
  "adresse":"adresse", "adresses":"adresse",
  "diplome":"diplôme", "diplomes":"diplôme", "diplômes":"diplôme",
  "education":"éducation", "educations":"éducation",
  "famille":"famille", "familles":"famille",
  "pieton":"piéton", "pietons":"piéton", "piétons":"piéton",
  "velo":"vélo", "velos":"vélo", "vélo":"vélo", "vélos":"vélo",
  "arret":"arrêt", "arrets":"arrêt", "arrêts":"arrêt",
  "itineraire":"itinéraire", "itineraires":"itinéraire", "itinéraires":"itinéraire",
  "stationnement":"stationnement", "parkings":"parking", "voitures":"voiture", "voiries":"voirie", "lignes":"ligne", "stations":"station", "routes":"route", "rues":"rue", "arbres":"arbre", "communes":"commune", "quartiers":"quartier",
  "localisation":"localisation", "geopoint":"GeoPoint", "geo_point":"GeoPoint", "geopoint_2d":"GeoPoint", "geoshape":"GeoShape", "geo_shape":"GeoShape", "code_insee":"code_insee", "code_postal":"code_postal",
  "archive":"archive", "archives":"archive", "archivage":"archive",
  "recensement_population":"recensement", "recensement":"recensement",
  "grands_quartiers":"grands_quartiers", "grand_quartier":"grands_quartiers", "grands_quartier":"grands_quartiers",
  "pech_david":"pech_david", "basso_cambo":"basso_cambo"
};
const CLOUD_DROP_PATTERNS = [
  /^\d+$/, /^\d{1,4}[a-z]*$/, /^(dd|mm|yy|yyyy|hh|mn|ss)$/,
  /^(dd[-_]mm[-_]yy|mm[-_]dd[-_]yy|yyyy[-_]mm[-_]dd|dd[-_]mm[-_]yy[-_]hh[-_]mm)$/,
  /^.*[-_]?maj([-_].*)?$/, /^non[-_]?renseigne(e|es|s)?$/,
  /^\d+[-_]?(minute|minutes|heure|heures)$/, /^(minute|minutes|heure|heures)$/,
  /^(quotidien|quotidienne|hebdomadaire|mensuel|mensuelle|annuel|annuelle|periodicite|périodicité|frequence|fréquence)$/,
  /^(libelle|libellé|identifiant|identifiants|description|periode|période|renseignement|renseignements)$/,
  /^(objectid|fid|gid|uuid|shape|shape_area|shape_length)$/,
  /^(lat|lon|long|coord|coordonnees|coordonnées|ylat|xlong|altitude|no|lib_voie|street|street_name|name)$/,
  /^(test|exemple|divers|inconnu|inconnue|null|na|n_a|sans_objet|autre|autres|salade|david)$/,
  /^id[-_]?.*/, /^num[-_]?.*/, /^lib[-_]?.*/, /^cod[-_]?.*/, /^code$/, /^field\d*$/, /^x_?.*/, /^y_?.*/,
  /^grd$/, /^sot$/, /^d$/, /^l$/, /^no\d+$/, /^\d{5,}$/
];
/** Rôle : Nettoie un texte avant l'extraction des termes du nuage. */
function prepareCloudText(value){
  return stripAccents(String(value || "").toLowerCase())
    .replace(/\([^)]*maj[^)]*\)/g, " ")
    .replace(/\bmaj\b[^,;.]*/g, " ")
    .replace(/[’']/g, " ")
    .replace(/\bnon[\s_-]+classe\b/g, " ")
    .replace(/\bd[\s_-]+(eau|energie|annee|air|adresse|humidite|electricite)\b/g, "$1")
    .replace(/\bl[\s_-]+(eau|energie|annee|air|adresse|humidite|electricite)\b/g, "$1")
    .replace(/\bsot[\s_-]+annee\b/g, "annee")
    .replace(/\bd[\s_-]+heure\b/g, " ")
    .replace(/\bd[\s_-]+minute\b/g, " ")
    .replace(/\bgrd[\s_-]+quart\b/g, " ")
    .replace(/\bgrands?[\s_-]+quartiers?\b/g, " grands_quartiers ")
    .replace(/\bpech[\s_-]+david\b/g, " pech_david ")
    .replace(/\bbasso[\s_-]+cambo\b/g, " basso_cambo ")
    .replace(/\bchom[\s_-]*1564\b/g, " chômage ")
    .replace(/\binactive[\s_-]*1564\b/g, " inactivité ")
    .replace(/\bpop[\s_-]*1564\b/g, " population ")
    .replace(/\bp20[\s_-]*pop\b/g, " population ")
    .replace(/\bnb[\s_-]*logt\b/g, " logement ")
    .replace(/\btemp[\s_-]*moy\b/g, " température ")
    .replace(/\bgeo[\s_-]*point\b/g, " GeoPoint ")
    .replace(/\bgeo[\s_-]*shape\b/g, " GeoShape ")
    .replace(/\bcode[\s_-]*insee\b/g, " code_insee ")
    .replace(/\bcode[\s_-]*postal\b/g, " code_postal ");
}
/** Rôle : Ramène certains termes pluriels à une forme singulière commune. */
function singularizeCloudTerm(term){
  if(CLOUD_PROTECTED_TERMS.has(term)) return term;
  const lower = stripAccents(String(term).toLowerCase());
  if(CLOUD_EXACT_MAP[lower]) return CLOUD_EXACT_MAP[lower];
  if(term.length > 4 && lower.endsWith("aux")) return term.slice(0, -3) + "al";
  if(term.length > 4 && lower.endsWith("eaux")) return term.slice(0, -1);
  if(term.length > 4 && lower.endsWith("s") && !lower.endsWith("ss")) return term.slice(0, -1);
  return term;
}
/** Rôle : Vérifie si un terme appartient au vocabulaire métier conservé dans le nuage. */
function isCloudDomainTerm(term){
  const lower = stripAccents(String(term || "").toLowerCase());
  return CLOUD_DOMAIN_TERMS.has(term) || CLOUD_DOMAIN_TERMS.has(lower) || CLOUD_PROTECTED_TERMS.has(term);
}
/** Rôle : Normalise un terme extrait avant son comptage dans le nuage. */
function normalizeCloudTerm(value){
  let raw = String(value || "").trim();
  if(!raw) return "";
  let key0 = stripAccents(raw.toLowerCase())
    .replace(/[’']/g, " ")
    .replace(/-+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if(/^recensement_population(_?\d{4})?$/.test(key0)) return "recensement";
  if(/^archives?(_?\d{4})?$/.test(key0) || /^archive/.test(key0)) return "archive";
  if(key0 === "meteopole" || key0 === "metropole") return "";
  if(key0 === "activite_copie" || key0 === "activitecopie") return "";
  if(key0 === "non" || key0.startsWith("non_")) return "";
  if(key0.startsWith("non_classe") || /^non_?classe/.test(key0)) return "";
  if(key0.startsWith("non_renseigne") || /^non_?renseigne/.test(key0)) return "";
  if(key0 === "maj" || key0.startsWith("maj_") || key0.includes("_maj_") || key0.endsWith("_maj")) return "";
  if(/^chom(age)?_?\d+/.test(key0) || /^chom\d+/.test(key0)) return "chômage";
  if(/^inactive?_?\d+/.test(key0)) return "inactivité";
  if(/^(pop|population)_?\d+/.test(key0) || /^p\d+_pop$/.test(key0)) return "population";
  if(/^(nb_)?logt/.test(key0)) return "logement";

  let term = prepareCloudText(raw)
    .replace(/[^a-z0-9_éèêëàâäîïôöùûüç-]+/gi, " ")
    .trim();
  if(!term) return "";
  term = term.replace(/-+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  let lookup = stripAccents(term.toLowerCase());
  term = CLOUD_EXACT_MAP[lookup] || CLOUD_EXACT_MAP[term] || term;
  term = singularizeCloudTerm(term);
  const lower = stripAccents(String(term).toLowerCase());
  if(CLOUD_STOPWORDS.has(lower) || CLOUD_STOPWORDS.has(term)) return "";
  if(CLOUD_DROP_PATTERNS.some(rx => rx.test(lower))) return "";
  if(lower.length < 3 && !CLOUD_SHORT_KEEP.has(lower)) return "";
  if(String(term).length > 40) return "";
  return term;
}
/** Rôle : Rassemble les textes de métadonnées utilisés pour produire les mots-clés. */
function cloudTextPartsFromAttributes(attrs){
  const parts = [];
  if(!attrs) return parts;
  if(Array.isArray(attrs)) return attrs;
  if(typeof attrs === "object"){
    Object.entries(attrs).forEach(([k,v]) => {
      parts.push(k);
      if(Array.isArray(v)) parts.push(...v);
      else parts.push(String(v || ""));
    });
    return parts;
  }
  return [String(attrs || "")];
}
/** Rôle : Extrait et normalise les termes pertinents présents dans un texte. */
function extractCloudTermsFromText(text, source="text"){
  const prepared = prepareCloudText(text);
  const terms = [];
  const protectedExpr = ["grands_quartiers", "pech_david", "basso_cambo", "mobilite_douce", "code_insee", "code_postal"];
  protectedExpr.forEach(expr => {
    if(prepared.includes(expr)){
      const term = normalizeCloudTerm(expr);
      if(term) terms.push(term);
    }
  });
  prepared
    .replace(/grands_quartiers|pech_david|basso_cambo|mobilite_douce|code_insee|code_postal/g, " ")
    .split(/[\s,;:()\[\]{}\/\\|+._]+/)
    .forEach(token => {
      const term = normalizeCloudTerm(token);
      if(!term) return;
      if(source === "attributes" && !isCloudDomainTerm(term)) return;
      if((source === "description" || source === "metadata") && !isCloudDomainTerm(term)) return;
      terms.push(term);
    });
  return [...new Set(terms)];
}
/** Rôle : Extrait l'ensemble des termes pertinents d'un jeu de données. */
function extractCloudTermsFromDataset(d){
  const groups = [
    {source:"title", values:[d.title || d.nom || d.name]},
    {source:"tag", values:toArray(d.tags)},
    {source:"description", values:[d.description, d.commentaires || d.commentaire]},
    {source:"metadata", values:[d.theme, d.geometry || d.geometrie || d.geolocalisation || d.geoLocalisation, d.frequence, d.granularite || d.granulariteTemporelle]},
    {source:"attributes", values:cloudTextPartsFromAttributes(d.attributs)}
  ];
  const terms = new Set();
  groups.forEach(group => group.values.filter(Boolean).forEach(value => extractCloudTermsFromText(value, group.source).forEach(t => terms.add(t))));
  return [...terms];
}


/** Rôle : Choisit la forme lisible affichée pour un terme normalisé. */
function normalizeCloudDisplayTerm(term){
  const key = stripAccents(String(term || "").toLowerCase())
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  // Regroupement visuel : ces termes décrivent la même notion de localisation.
  // Le nuage doit donc additionner leurs occurrences sous un seul libellé.
  if([
    "localisation", "geolocalisation", "geometrie", "geographie",
    "geopoint", "geo_point", "geopoint_2d",
    "geoshape", "geo_shape",
    "coord", "coords", "coordonnee", "coordonnees",
    "latitude", "longitude", "lat", "lon", "long", "xlong", "ylat"
  ].includes(key)) return "localisation";
  return term;
}

/** Rôle : Normalise le libellé d'une thématique. */
function normalizeThemeName(value){
  const raw = stripAccents(String(value || "").toLowerCase()).trim();
  if(raw.includes("transport")) return "Transport";
  if(raw.includes("environnement")) return "Environnement";
  if(raw.includes("population")) return "Population";
  if(raw.includes("espace")) return "Espaces publics";
  if(raw.includes("batiment") || raw.includes("bâtiment")) return "Bâtiment";
  if(raw.includes("technologie")) return "Technologie";
  return "Autres";
}
/** Rôle : Construit le nom de classe CSS associé à une thématique. */
function themeClassName(theme){
  const key = stripAccents(String(theme || "").toLowerCase()).replace(/\s+/g, "-");
  if(key.includes("transport")) return "theme-transport";
  if(key.includes("environnement")) return "theme-environnement";
  if(key.includes("population")) return "theme-population";
  if(key.includes("espace")) return "theme-espaces";
  if(key.includes("batiment")) return "theme-batiment";
  if(key.includes("technologie")) return "theme-technologie";
  return "theme-autres";
}
/** Rôle : Assure le traitement associé à « theme description ». */
function themeDescription(theme){
  return {
    "Transport":"Données relatives aux déplacements, infrastructures et mobilités.",
    "Environnement":"Données sur le climat, les ressources naturelles et la qualité de l’environnement.",
    "Population":"Données démographiques et sociales.",
    "Espaces publics":"Données sur les espaces, équipements et lieux publics.",
    "Bâtiment":"Données sur les bâtiments, logements et constructions.",
    "Technologie":"Données liées au numérique, aux réseaux et aux systèmes."
  }[theme] || "Mots-clés associés aux autres thématiques.";
}
/** Rôle : Assure le traitement associé à « theme icon ». */
function themeIcon(theme){
  return {
    "Transport":"🚌",
    "Environnement":"🌿",
    "Population":"👥",
    "Espaces publics":"🌳",
    "Bâtiment":"🏢",
    "Technologie":"⚙️"
  }[theme] || "🔎";
}
/** Rôle : Construit cloud items. */
function buildCloudItems(){
  const globalMap = {};
  const themeMap = {};
  const sourceWeights = {title:10, tag:8, description:5, metadata:3, attributes:2};
  datasets.forEach(d => {
    const theme = normalizeThemeName(d.theme || d.thematique || d.category || "Autres");
    const modified = normalizeLastModified(d.lastModified || d.last_modified || d.derniereMaj || d.derniere_maj || d.dateFin || d.date_fin || d.dateDebut || d.date_debut);
    const groups = [
      {source:"title", values:[d.title || d.nom || d.name]},
      {source:"tag", values:toArray(d.tags)},
      {source:"description", values:[d.description, d.commentaires || d.commentaire]},
      {source:"metadata", values:[d.theme, d.geometry || d.geometrie || d.geolocalisation || d.geoLocalisation, d.frequence_auto, d.frequence, d.granularite || d.granulariteTemporelle]},
      {source:"attributes", values:cloudTextPartsFromAttributes(d.attributs)}
    ];
    const perDataset = {};
    groups.forEach(group => {
      group.values.filter(Boolean).forEach(value => {
        extractCloudTermsFromText(value, group.source).forEach(originalTerm => {
          const term = originalTerm;
          if(!term) return;
          if(!perDataset[term]) perDataset[term] = {score:0, occurrences:0, sources:{title:0, tag:0, description:0, metadata:0, attributes:0}};
          perDataset[term].occurrences += 1;
          perDataset[term].score += sourceWeights[group.source] || 1;
          perDataset[term].sources[group.source] = (perDataset[term].sources[group.source] || 0) + 1;
        });
      });
    });
    Object.entries(perDataset).forEach(([term, info]) => {
      if(!globalMap[term]) globalMap[term] = {term, count:0, score:0, modified:"0000-00-00", sources:{title:0, tag:0, description:0, metadata:0, attributes:0}};
      // Comptage cohérent avec le catalogue : 1 dataset = 1 occurrence du mot.
      // Avant, le nuage additionnait les répétitions dans titre/description/attributs,
      // ce qui donnait des valeurs incompatibles avec le filtrage du catalogue.
      globalMap[term].count += 1;
      globalMap[term].score += info.score;
      Object.entries(info.sources).forEach(([src, n]) => globalMap[term].sources[src] += n);
      if(modified > globalMap[term].modified) globalMap[term].modified = modified;

      if(!themeMap[theme]) themeMap[theme] = {};
      if(!themeMap[theme][term]) themeMap[theme][term] = {term, theme, count:0, score:0, modified:"0000-00-00", sources:{title:0, tag:0, description:0, metadata:0, attributes:0}};
      themeMap[theme][term].count += 1;
      themeMap[theme][term].score += info.score;
      Object.entries(info.sources).forEach(([src, n]) => themeMap[theme][term].sources[src] += n);
      if(modified > themeMap[theme][term].modified) themeMap[theme][term].modified = modified;
    });
  });
  const keepItem = item => {
    const k = stripAccents(String(item.term || "").toLowerCase()).replace(/[\s-]+/g, "_");
    if(k.startsWith("non_classe") || /^non_?classe/.test(k)) return false;
    if(isCloudDomainTerm(item.term)) return true;
    if(item.sources.tag > 0) return true;
    if(item.sources.title >= 2 && item.count >= 2) return true;
    return false;
  };
  Object.keys(globalMap).forEach(key => {
    const k = stripAccents(String(key || "").toLowerCase()).replace(/[\s-]+/g, "_");
    if(k.startsWith("non_classe") || /^non_?classe/.test(k) || k === "david") delete globalMap[key];
  });
  Object.values(themeMap).forEach(terms => {
    Object.keys(terms).forEach(key => {
      const k = stripAccents(String(key || "").toLowerCase()).replace(/[\s-]+/g, "_");
      if(k.startsWith("non_classe") || /^non_?classe/.test(k) || k === "david") delete terms[key];
    });
  });

  // Agrégation visuelle des sous-ensembles : le nuage affiche un seul libellé
  // avec la somme des vrais compteurs, sans modifier les mots du catalogue.
  const visualGroups = {
    "localisation": ["localisation", "GeoPoint", "GeoShape"],
    "météo": ["météo", "station_meteo"],
    "mobilité_douce": ["mobilité_douce", "vélo", "VélôToulouse"],
    "quartier": ["quartier", "IRIS", "Avenue", "Rue", "Boulevard", "Place", "Impasse", "Chemin", "Secteur", "grands_quartiers"],
    "éducation": ["éducation", "École", "Scolaire", "Diplôme", "Maternelle", "Établissement"],
    "espace_public": ["espace_public", "espaces_publics"]
  };
  const aggregateMap = (map) => {
    Object.entries(visualGroups).forEach(([label, members]) => {
      // Les groupes ne doivent jamais être obtenus par addition des compteurs
      // des membres : le même dataset pourrait alors être compté plusieurs fois.
      // Le compteur final est remplacé plus bas par une union dataset par dataset.
      members.forEach(member => {
        if(member !== label) delete map[member];
      });
    });
  };
  aggregateMap(globalMap);
  Object.values(themeMap).forEach(aggregateMap);

    cloudItems = Object.values(globalMap).filter(keepItem);
  cloudThemeItems = Object.entries(themeMap).map(([theme, terms]) => ({
    theme,
    items: Object.values(terms).filter(keepItem)
  })).filter(group => group.items.length);
}



/* ================================================================
   CORRECTION COMPTAGE UNIQUE
   Même principe que le nuage visuel : cette page ne calcule plus les
   fréquences à partir des titres/descriptions/attributs. Les nombres
   affichés viennent exclusivement des tags normalisés, donc ils restent
   identiques aux compteurs du catalogue.
================================================================ */
/** Rôle : Normalise tag value for cloud. */
function normalizeTagValueForCloud(value){
  let original = String(value || "").trim().toLowerCase();
  if(!original) return "";
  original = original.replace(/\s+/g, "_").replace(/[’']/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  let key = stripAccents(original);
  if(["non_classe", "non_classé", "non_classee", "non_renseigne", "non_renseigné", "non_renseignee"].includes(original) || ["non_classe", "non_classee", "non_renseigne", "non_renseignee"].includes(key)) return "";
  const exact = {
    "meteo":"météo", "meteos":"météo", "mobilite_douce":"mobilité_douce", "mobilites_douces":"mobilité_douce",
    "transport":"transport", "transports":"transport", "tranport":"transport", "tranports":"transport",
    "velo":"vélo", "velos":"vélo", "pieton":"piéton", "pietons":"piéton", "arret":"arrêt", "arrets":"arrêt",
    "itineraire":"itinéraire", "itineraires":"itinéraire", "temperature":"température", "temperatures":"température",
    "precipitation":"précipitation", "precipitations":"précipitation", "batiment":"bâtiment", "batiments":"bâtiment",
    "donnee":"donnée", "donnees":"donnée", "capacite":"capacité", "capacites":"capacité", "equipement":"équipement", "equipements":"équipement",
    "electricite":"électricité", "electrique":"électrique", "voiries":"voirie", "stations":"station", "lignes":"ligne", "taxis":"taxi",
    "deplacements":"déplacement", "logements":"logement", "services":"service", "parkings":"parking", "quartiers":"quartier", "communes":"commune",
    "routes":"route", "rues":"rue", "arbres":"arbre", "espaces_verts":"espace_vert", "risques":"risque", "inondations":"inondation",
    "interventions":"intervention", "comptages":"comptage", "geopoint":"GeoPoint", "geo_point":"GeoPoint", "geopoint_2d":"GeoPoint",
    "geoshape":"GeoShape", "geo_shape":"GeoShape", "archives":"archive", "archivage":"archive",
    "grands_quartiers":"grands_quartiers", "grand_quartier":"grands_quartiers", "grands_quartier":"grands_quartiers"
  };
  if(exact[key]) return exact[key];
  const parts = key.split("_").map(part => {
    if(exact[part]) return exact[part];
    if(part.length > 4 && part.endsWith("aux")) return part.slice(0, -3) + "al";
    if(part.length > 4 && part.endsWith("eaux")) return part.slice(0, -1);
    if(part.length > 4 && part.endsWith("s") && !part.endsWith("ss")) return part.slice(0, -1);
    return part;
  });
  return parts.join("_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}
/** Rôle : Normalise tags for cloud. */
function normalizeTagsForCloud(values){
  return [...new Set(toArray(values).map(normalizeTagValueForCloud).filter(Boolean))];
}
/** Rôle : Construit cloud items. */
function buildCloudItems(){
  // RÈGLE DÉFINITIVE :
  // - mots simples = mêmes compteurs que le catalogue (tags normalisés uniquement)
  // - mots parents / sous-ensembles = somme des compteurs individuels recherchables
  //   Exemple : localisation = localisation + GeoPoint + GeoShape.
  const tagGlobalMap = {};
  const tagThemeMap = {};
  const searchableGlobalMap = {};
  const searchableThemeMap = {};

  const addItem = (map, term, theme, modified, score=8, source="tag") => {
    if(!term) return;
    if(!map[term]) map[term] = {term, theme, count:0, score:0, modified:"0000-00-00", sources:{title:0, tag:0, description:0, metadata:0, attributes:0}};
    map[term].count += 1;
    map[term].score += score;
    map[term].sources[source] = (map[term].sources[source] || 0) + 1;
    if(modified > map[term].modified) map[term].modified = modified;
  };

  datasets.forEach(d => {
    const theme = normalizeThemeName(d.theme || d.thematique || d.category || "Autres");
    const modified = normalizeLastModified(d.lastModified || d.last_modified || d.derniereMaj || d.derniere_maj || d.dateFin || d.date_fin || d.dateDebut || d.date_debut);

    // Base catalogue : tags uniquement.
    normalizeTagsForCloud(d.tags).forEach(term => {
      addItem(tagGlobalMap, term, theme, modified, 8, "tag");
      if(!tagThemeMap[theme]) tagThemeMap[theme] = {};
      addItem(tagThemeMap[theme], term, theme, modified, 8, "tag");
    });

    // Base recherchable : utilisée seulement pour sommer les groupes.
    extractCloudTermsFromDataset(d).forEach(term => {
      addItem(searchableGlobalMap, term, theme, modified, 8, "tag");
      if(!searchableThemeMap[theme]) searchableThemeMap[theme] = {};
      addItem(searchableThemeMap[theme], term, theme, modified, 8, "tag");
    });
  });

  const visualGroups = {
    "localisation": ["localisation", "GeoPoint", "GeoShape"],
    "météo": ["météo", "station_meteo"],
    "mobilité_douce": ["mobilité_douce", "vélo", "VélôToulouse"],
    "quartier": ["quartier", "IRIS", "Avenue", "Rue", "Boulevard", "Place", "Impasse", "Chemin", "Secteur", "grands_quartiers"],
    "éducation": ["éducation", "École", "Scolaire", "Diplôme", "Maternelle", "Établissement"],
    "espace_public": ["espace_public", "espaces_publics"]
  };

  const groupStatsGlobal = {};
  const groupStatsByTheme = {};

  Object.keys(visualGroups).forEach(label => {
    groupStatsGlobal[label] = {count:0, score:0, modified:"0000-00-00", sources:{title:0, tag:0, description:0, metadata:0, attributes:0}};
  });

  // Recalcul par dataset afin d'obtenir une UNION réelle et non une somme.
  datasets.forEach(d => {
    const theme = normalizeThemeName(d.theme || d.thematique || d.category || "Autres");
    const modified = normalizeLastModified(d.lastModified || d.last_modified || d.derniereMaj || d.derniere_maj || d.dateFin || d.date_fin || d.dateDebut || d.date_debut);
    // Recherche des membres dans l'ensemble du dataset, pas uniquement dans
    // les tags ou dans une extraction partielle. Le parent représente donc
    // bien l'UNION des datasets qui contiennent au moins un membre.
    const groupHaystack = `_${stripAccents(JSON.stringify(d || {}).toLowerCase())
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")}_`;

    Object.entries(visualGroups).forEach(([label, members]) => {
      const normalizedMembers = new Set(normalizeTagsForCloud(members).map(value =>
        stripAccents(String(value || "").toLowerCase())
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/_+/g, "_")
          .replace(/^_|_$/g, "")
      ));
      const matches = [...normalizedMembers].some(member =>
        member && groupHaystack.includes(`_${member}_`)
      );
      if (!matches) return;

      const update = stats => {
        stats.count += 1;
        stats.score += 8;
        stats.sources.tag += 1;
        if (modified > stats.modified) stats.modified = modified;
      };
      update(groupStatsGlobal[label]);
      if (!groupStatsByTheme[theme]) groupStatsByTheme[theme] = {};
      if (!groupStatsByTheme[theme][label]) {
        groupStatsByTheme[theme][label] = {count:0, score:0, modified:"0000-00-00", sources:{title:0, tag:0, description:0, metadata:0, attributes:0}};
      }
      update(groupStatsByTheme[theme][label]);
    });
  });

  const applyGroupStats = (baseMap, statsMap) => {
    Object.entries(visualGroups).forEach(([label, members]) => {
      normalizeTagsForCloud(members).forEach(norm => {
        if (norm !== label) delete baseMap[norm];
      });
      const stats = statsMap[label];
      if (stats && stats.count > 0) baseMap[label] = {term:label, ...stats};
    });
  };

  applyGroupStats(tagGlobalMap, groupStatsGlobal);
  Object.keys(tagThemeMap).forEach(theme => applyGroupStats(tagThemeMap[theme], groupStatsByTheme[theme] || {}));

  cloudItems = Object.values(tagGlobalMap).filter(item => item.term && item.count > 0);
  cloudThemeItems = Object.entries(tagThemeMap).map(([theme, terms]) => ({theme, items:Object.values(terms).filter(item => item.term && item.count > 0)})).filter(group => group.items.length);
}
/** Rôle : Assure le traitement associé à « sort label ». */
function sortLabel(mode){return mode==="az"?"A-Z":mode==="za"?"Z-A":mode==="size"?"Taille": "Last modified";}
/** Rôle : Assure le traitement associé à « expand cloud keyword selection ». */
function expandCloudKeywordSelection(values){
  const groups = {
    localisation: ["localisation", "GeoPoint", "GeoShape"],
    meteo: ["météo", "station_meteo"],
    mobilite_douce: ["mobilité_douce", "vélo", "VélôToulouse"],
    quartier: ["quartier", "IRIS", "Avenue", "Rue", "Boulevard", "Place", "Impasse", "Chemin", "Secteur", "grands_quartiers"],
    education: ["éducation", "École", "Scolaire", "Diplôme", "Maternelle", "Établissement"],
    espace_public: ["espace_public", "espaces_publics"]
  };
  const keyOf = v => stripAccents(String(v || "").toLowerCase()).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const expanded = [];
  const add = (value) => {
    const term = normalizeCloudTerm(value);
    if(term && !expanded.includes(term)) expanded.push(term);
  };
  (Array.isArray(values) ? values : []).forEach(value => {
    const group = groups[keyOf(value)];
    if(group) group.forEach(add);
    else add(value);
  });
  return expanded;
}

/** Rôle : Charge selection. */
function loadSelection(){
  try{
    selectedCloudKeywords = expandCloudKeywordSelection(JSON.parse(localStorage.getItem("selectedCloudKeywords") || "[]"));
  }catch(e){ selectedCloudKeywords = []; }
}
/** Rôle : Assure le traitement associé à « save selection ». */
function saveSelection(){
  selectedCloudKeywords = expandCloudKeywordSelection(selectedCloudKeywords);
  localStorage.setItem("selectedCloudKeywords", JSON.stringify(selectedCloudKeywords));
}
/** Rôle : Affiche selected. */
function renderSelected(){
  $("selectedWordsCount").textContent = selectedCloudKeywords.length;
  const bar = $("selectedCloudBar");
  if(!selectedCloudKeywords.length){
    bar.classList.add("hidden");
    $("selectedCloudChips").innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  const counts = Object.fromEntries(cloudItems.map(i => [i.term, i.count]));
  $("selectedCloudChips").innerHTML = selectedCloudKeywords.map(term =>
    `<button class="selected-chip" data-remove-cloud="${escapeHtml(term)}">${escapeHtml(term)}<strong>${counts[term] || 0}</strong><span>×</span></button>`
  ).join("");
  document.querySelectorAll("[data-remove-cloud]").forEach(btn => btn.onclick = () => {
    selectedCloudKeywords = selectedCloudKeywords.filter(k => k !== btn.dataset.removeCloud);
    saveSelection();
    renderCloud();
  });
}
/** Rôle : Assure le traitement associé à « cloud font size ». */
function cloudFontSize(count){
  // Taille fixe : tous les mots-clés ont la même taille visuelle.
  return 18;
}
/** Rôle : Assure le traitement associé à « sort cloud items ». */
function sortCloudItems(items){
  return [...items].sort((a,b)=>{
    if(cloudSortValue === "az") return a.term.localeCompare(b.term);
    if(cloudSortValue === "za") return b.term.localeCompare(a.term);
    if(cloudSortValue === "modified") return b.modified.localeCompare(a.modified) || a.term.localeCompare(b.term);
    return b.count - a.count || a.term.localeCompare(b.term);
  });
}
/** Rôle : Affiche cloud. */
function renderCloud(){
  const q = normalizeCloudTerm($("cloudSearch").value) || stripAccents($("cloudSearch").value.toLowerCase().trim());
  const orderedThemes = ["Transport","Environnement","Population","Espaces publics","Bâtiment","Technologie","Autres"];
  const groups = [...cloudThemeItems].sort((a,b) => orderedThemes.indexOf(a.theme) - orderedThemes.indexOf(b.theme));
  let visibleWordTotal = 0;
  const html = groups.map(group => {
    const items = sortCloudItems(group.items.filter(item => !q || item.term.includes(q)));
    if(!items.length) return "";
    visibleWordTotal += items.length;
    const cls = themeClassName(group.theme);
    return `
      <section class="theme-cloud-card ${cls}">
        <div class="theme-cloud-head">
          <div class="theme-title-wrap">
            <span class="theme-icon" aria-hidden="true">${themeIcon(group.theme)}</span>
            <div>
              <h3>${escapeHtml(group.theme)}</h3>
              <p>${escapeHtml(themeDescription(group.theme))}</p>
            </div>
          </div>
          <span class="theme-count">${items.length} mots</span>
        </div>
        <div class="theme-word-list">
          ${items.map(item => {
            const active = selectedCloudKeywords.includes(item.term) ? " active" : "";
            return `<button class="cloud-word${active}" style="font-size:${cloudFontSize(item.count)}px" data-cloud-term="${escapeHtml(item.term)}">${escapeHtml(item.term)} <strong>${item.count}</strong></button>`;
          }).join("")}
        </div>
      </section>`;
  }).join("");
  $("totalWords").textContent = visibleWordTotal;
  $("cloudWords").innerHTML = html || `<p class="empty-state">Aucun mot ne correspond à la recherche.</p>`;
  document.querySelectorAll("[data-cloud-term]").forEach(btn => btn.onclick = () => {
    const term = btn.dataset.cloudTerm;
    selectedCloudKeywords = selectedCloudKeywords.includes(term)
      ? selectedCloudKeywords.filter(k => k !== term)
      : [...selectedCloudKeywords, term];
    saveSelection();
    renderCloud();
  });
  renderSelected();
}

/** Rôle : Charge les métadonnées du catalogue depuis la source configurée. */
async function loadDatasets(){
  if(!APPS_SCRIPT_URL) return;
  try{
    const response = await fetch(APPS_SCRIPT_URL + `?sheetId=${encodeURIComponent(GOOGLE_SHEET_ID)}&t=${Date.now()}`);
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    datasets = Array.isArray(data) ? data : data.datasets || datasets;
  }catch(error){
    console.error("Impossible de charger Google Sheet. Données locales utilisées.", error);
  }
}
/** Rôle : Initialise les événements et composants interactifs de l'interface du catalogue. */
function setupUI(){
  $("cloudSortBtn").onclick = () => $("cloudSortMenu").classList.toggle("hidden");
  document.querySelectorAll("[data-cloudsort]").forEach(btn => btn.onclick = () => {
    cloudSortValue = btn.dataset.cloudsort;
    $("cloudSortBtn").innerHTML = `Tri : ${sortLabel(cloudSortValue)} <span>▾</span>`;
    $("cloudSortMenu").classList.add("hidden");
    renderCloud();
  });
  document.addEventListener("click", e => {
    if(!e.target.closest(".select-menu")) document.querySelectorAll(".select-popover").forEach(m => m.classList.add("hidden"));
  });
  $("cloudSearch").addEventListener("input", renderCloud);
  $("resetCloudBtn").onclick = () => {
    selectedCloudKeywords = [];
    localStorage.removeItem("selectedCloudKeywords");
    $("cloudSearch").value = "";
    renderCloud();
  };
  $("confirmCloudBtn").onclick = () => {
    saveSelection();
    window.location.href = "/index.html";
  };
}
/** Rôle : Initialise le catalogue, charge les données et déclenche le premier affichage. */
async function init(){
  setupUI();
  $("cloudWords").innerHTML = `<div class="cloud-loading-inline"><div class="cloud-spinner-inline" aria-hidden="true"></div><p>Chargement des mots-clés…</p></div>`;
  await loadDatasets();
  buildCloudItems();
  loadSelection();
  renderCloud();
}
init();
