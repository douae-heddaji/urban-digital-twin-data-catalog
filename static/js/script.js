// 1) Mets ici l’URL /exec obtenue après le déploiement Apps Script.
// Exemple : const APPS_SCRIPT_URL = "https://script.google.com/macros/s/XXXXX/exec";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzHJJUeJXdHcTOiDyAtBnZ1eQsyR4IgWpbW2mFK_9Vv7WtG9_tStrYhCRQ2reJy9hlMYA/exec";
const GOOGLE_SHEET_ID = "1hlZBcHTi2NvcqdmKnrUqhuyJnW_ls0TUOxNPkHEl6dc";

let datasets = Array.isArray(window.SAMPLE_DATASETS) ? window.SAMPLE_DATASETS : [];

const monthsOrder = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const monthShort = {Janvier:"Jan", Février:"Fév", Mars:"Mar", Avril:"Avr", Mai:"Mai", Juin:"Jui", Juillet:"Juil", Août:"Aoû", Septembre:"Sep", Octobre:"Oct", Novembre:"Nov", Décembre:"Déc"};
let selectedKeywords = [];
let keywordSortValue = "az";
let tagSortValue = "az";
let timeYearMin = null;
let timeYearMax = null;
let timeFilterStartYear = null;
let timeFilterEndYear = null;
let timeFilterActive = false;
const selectedMapDatasets = new Map();

const $ = id => document.getElementById(id);
const grid = $("datasetGrid"), searchInput = $("searchInput"), keywordSearch = $("keywordSearch"), tagSearch = $("tagSearch"), datasetSort = $("datasetSort");

/** Rôle : Convertit une valeur simple ou séparée par des délimiteurs en tableau nettoyé. */
function toArray(v){ return Array.isArray(v) ? v : String(v || "").split(/[;,]/).map(x=>x.trim()).filter(Boolean); }

/** Rôle : Supprime les accents afin de rendre les recherches textuelles plus robustes. */
function stripAccents(value){
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Rôle : Transforme un texte en mots normalisés utilisés par le moteur de recherche. */
function searchTokens(value){
  return stripAccents(String(value || '').toLowerCase())
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);
}
/** Rôle : Vérifie si un mot-clé correspond à la recherche saisie. */
function keywordMatchesSearch(tag, query){
  const tokens = searchTokens(query);
  if(!tokens.length) return true;
  const normalizedTag = stripAccents(String(tag || '').toLowerCase());
  return tokens.some(token => normalizedTag.includes(token));
}

/** Rôle : Normalise la valeur d'un mot-clé avant son affichage et sa comparaison. */
function normalizeTagValue(value){
  let original = String(value || "").trim().toLowerCase();
  if(!original) return "";

  // Nettoyage commun : espaces et apostrophes deviennent des underscores.
  original = original.replace(/\s+/g, "_");
  original = original.replace(/[’']/g, "_");
  original = original.replace(/_+/g, "_").replace(/^_|_$/g, "");

  // Les valeurs techniques de fallback ne sont pas de vrais mots-clés.
  // Avant, "non_classe" pouvait être compté dans la liste des mots-clés,
  // mais il était ensuite rejeté par le filtre du nuage de mots : résultat 0 dataset affiché.
  // On le supprime donc dès la normalisation des tags.
  if(["non_classe", "non_classé", "non_classe", "non_classée", "non_renseigne", "non_renseigné", "non_renseignée"].includes(original)) return "";

  // Clé sans accents pour reconnaître les variantes : météo/méteo/meteo, mobilité/mobilite, etc.
  let key = stripAccents(original);
  if(["non_classe", "non_classe", "non_classee", "non_renseigne", "non_renseignee"].includes(key)) return "";

  const exact = {
    // variantes / fautes / accents
    "meteo": "météo",
    "meteos": "météo",
    "mobilite_douce": "mobilité_douce",
    "mobilites_douces": "mobilité_douce",
    "transport": "transport",
    "transports": "transport",
    "tranport": "transport",
    "tranports": "transport",
    "velo": "vélo",
    "velos": "vélo",
    "pieton": "piéton",
    "pietons": "piéton",
    "arret": "arrêt",
    "arrets": "arrêt",
    "itineraire": "itinéraire",
    "itineraires": "itinéraire",
    "temperature": "température",
    "temperatures": "température",
    "precipitation": "précipitation",
    "precipitations": "précipitation",
    "batiment": "bâtiment",
    "batiments": "bâtiment",
    "donnee": "donnée",
    "donnees": "donnée",
    "capacite": "capacité",
    "capacites": "capacité",
    "equipement": "équipement",
    "equipements": "équipement",
    "electricite": "électricité",
    "electrique": "électrique",

    // singulier simple
    "voiries": "voirie",
    "stations": "station",
    "lignes": "ligne",
    "taxis": "taxi",
    "deplacements": "déplacement",
    "logements": "logement",
    "services": "service",
    "parkings": "parking",
    "quartiers": "quartier",
    "communes": "commune",
    "routes": "route",
    "rues": "rue",
    "arbres": "arbre",
    "espaces_verts": "espace_vert",
    "risques": "risque",
    "inondations": "inondation",
    "interventions": "intervention",
    "comptages": "comptage"
  };
  if(exact[key]) return exact[key];

  const parts = key.split("_").map(part => {
    if(exact[part]) return exact[part];
    if(part.length > 4 && part.endsWith("aux")) return part.slice(0, -3) + "al";
    if(part.length > 4 && part.endsWith("eaux")) return part.slice(0, -1);
    if(part.length > 4 && part.endsWith("s") && !part.endsWith("ss")) return part.slice(0, -1);
    return part;
  });

  const joined = parts.join("_");
  return exact[joined] || joined;
}

/** Rôle : Nettoie et déduplique la liste des mots-clés d'un jeu de données. */
function normalizeTags(values){
  return [...new Set(toArray(values).map(normalizeTagValue).filter(Boolean))];
}


/** Rôle : Normalise le nom du producteur pour regrouper les variantes équivalentes. */
function normalizePublisherValue(value){
  let raw = String(value || "").trim();
  if(!raw) return "Non renseigné";
  raw = raw.replace(/\s+/g, " ");
  const key = stripAccents(raw).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const map = {
    "data gouv fr": "Data Gouv FR",
    "data gouvfr": "Data Gouv FR",
    "datagouv fr": "Data Gouv FR",
    "data gouvern fr": "Data Gouv FR",
    "open data toulouse metropole": "Open Data Toulouse Métropole",
    "toulouse metropole": "Open Data Toulouse Métropole",
    "open data haute garonne": "Open Data Haute-Garonne",
    "haute garonne": "Open Data Haute-Garonne",
    "insee": "INSEE",
    "ign": "IGN",
    "non renseigne": "Non renseigné"
  };

  if(map[key]) return map[key];

  return raw;
}


const SUPPORTED_FORMATS = ["CSV", "JSON", "GEOJSON", "XLSX", "PARQUET", "ZIP", "SHP", "KML", "GPKG", "XML"];

/** Rôle : Détermine si les métadonnées indiquent la présence d'une géométrie exploitable. */
function hasGeometry(d){
  // On se base uniquement sur les champs qui décrivent réellement la géométrie.
  // La description générale n'est pas utilisée : une phrase comme
  // « pas de GeoPoint » ne doit surtout pas être interprétée comme une géométrie.
  const rawValues = [
    d.geometry,
    d.geometrie,
    d.geolocalisation,
    d.geoLocalisation,
    d.geometryField,
    d.geometry_field
  ].filter(Boolean);

  // Les attributs peuvent aussi contenir le nom d'un vrai champ géographique.
  // Ils sont regroupés par catégorie (ex. {"Att de GéoLocalisation": "GeoPoint, GeoShape"}) :
  // les clés ne sont que des libellés de catégorie, l'information utile (le
  // nom réel des champs géo) est dans les valeurs, donc il faut lire les deux.
  if(d.attributs && typeof d.attributs === "object"){
    rawValues.push(...Object.keys(d.attributs));
    rawValues.push(...Object.values(d.attributs));
  }

  const txt = stripAccents(String(rawValues.join(" ")).toLowerCase()).trim();
  if(!txt) return false;

  // Exclusions explicites : « pas de GeoPoint », « sans géométrie », etc.
  if(/(?:pas de|sans|aucun(?:e)?|non renseigne)[\s_-]*(?:geopoint|geoshape|geometrie|geometry|coordonnees?)/.test(txt)){
    return false;
  }

  return /(?:^|[^a-z0-9])(?:geo[_ -]?point(?:_2d)?|geo[_ -]?shape|geometry|geometrie|the_geom|geom|coordinates?|coordonnees?|latitude|longitude|lat|lon|polygon|multipolygon|linestring|point)(?:$|[^a-z0-9])/.test(txt);
}

/** Rôle : Détecte si un jeu de données provient vraisemblablement d'une plateforme OpenDataSoft. */
function looksLikeOpenDataSoft(d){
  // Repose sur la même détection générique par URL que isOpenDataSoftDataset
  // (définie plus bas mais hissée par le moteur JS comme toute déclaration de fonction).
  return isOpenDataSoftDataset(d);
}

/** Rôle : Détecte si un jeu de données provient vraisemblablement de data.gouv.fr. */
function looksLikeDataGouv(d){
  const txt = stripAccents(String([d.url, d.urlLabel, d.publisher, d.source].filter(Boolean).join(' ')).toLowerCase());
  return /data\.gouv\.fr|data\s*gouv/.test(txt);
}


/** Rôle : Normalise la liste des formats disponibles pour un jeu de données. */
function normalizeFormats(value){
  const values = Array.isArray(value) ? value : [value];
  const formats = [];
  const add = f => { if(f && SUPPORTED_FORMATS.includes(f) && !formats.includes(f)) formats.push(f); };

  values.forEach(item => {
    const original = String(item || "").trim();
    const raw = stripAccents(original.toLowerCase());
    if(!raw) return;

    // Détection par extension de fichier : plus fiable que le texte "Format json".
    // Exemple data.gouv : aires-de-jeux.geojson doit être GEOJSON, même si la page indique format json.
    const extMatches = raw.match(/\.([a-z0-9]+)(?=($|[?#\s)"']))/g) || [];
    extMatches.forEach(ext => {
      ext = ext.replace('.', '').toLowerCase();
      if(ext === 'csv') add('CSV');
      if(ext === 'json') add('JSON');
      if(ext === 'geojson') add('GEOJSON');
      if(ext === 'gpkg' || ext === 'geopackage') add('GPKG');
      if(ext === 'xlsx' || ext === 'xls') add('XLSX');
      if(ext === 'parquet' || ext === 'geoparquet') add('PARQUET');
      if(ext === 'zip') add('ZIP');
      if(ext === 'shp' || ext === 'shapefile') add('SHP');
      if(ext === 'kml') add('KML');
      if(ext === 'xml') add('XML');
    });

    // Détection par libellé de format.
    if(/\bcsv\b/.test(raw)) add('CSV');
    if(/geo\s*json|geojson/.test(raw)) add('GEOJSON');
    if(/\bjson\b/.test(raw) && !/geo\s*json|geojson/.test(raw)) add('JSON');
    if(/\bgpkg\b|geopackage|geo\s*package/.test(raw)) add('GPKG');
    if(/\bxlsx\b|\bxls\b|excel/.test(raw)) add('XLSX');
    if(/\bparquet\b|geoparquet/.test(raw)) add('PARQUET');
    if(/\bzip\b/.test(raw)) add('ZIP');
    if(/\bshp\b|shapefile/.test(raw)) add('SHP');
    if(/\bkml\b/.test(raw)) add('KML');
    if(/\bxml\b/.test(raw)) add('XML');
  });

  return formats;
}

/** Rôle : Déduit côté client les formats probables à partir des URL et métadonnées disponibles. */
function inferAutoFormatsClient(d){
  const sources = [];
  if(d.formatsAuto && d.formatsAuto.length) sources.push(d.formatsAuto);
  if(d.formatResources && d.formatResources.length) sources.push(d.formatResources);
  sources.push(d.format, d.url, d.urlLabel, d.description, d.commentaires, d.geometry);

  let formats = normalizeFormats(sources.flat());

  // Fallback général par plateforme, uniquement quand l’API/Apps Script n’a pas déjà trouvé les formats complets.
  // OpenDataSoft expose en général CSV, JSON, XLSX et PARQUET dans l’onglet Export.
  // Si une géométrie existe, on ajoute aussi les formats géographiques courants.
  if(looksLikeOpenDataSoft(d)){
    ["CSV", "JSON", "XLSX", "PARQUET"].forEach(f => { if(!formats.includes(f)) formats.push(f); });
    if(hasGeometry(d)) ["GEOJSON", "SHP", "KML"].forEach(f => { if(!formats.includes(f)) formats.push(f); });
  }

  // data.gouv : si Apps Script a récupéré les ressources, elles sont utilisées.
  // Sinon, on conserve la détection par extension/libellé comme secours.
  if(looksLikeDataGouv(d)){
    const detected = normalizeFormats([d.format, d.url, d.urlLabel, d.description, d.commentaires]);
    detected.forEach(f => { if(!formats.includes(f)) formats.push(f); });
  }

  return [...new Set(formats)].filter(f => SUPPORTED_FORMATS.includes(f));
}


/** Rôle : Détecte export modes. */
function detectExportModes(d, formats){
  const modes = [];
  const fmt = Array.isArray(formats) ? formats : normalizeFormats(formats || d.format || "");
  const text = stripAccents(String([
    d.url,
    d.urlLabel,
    d.publisher,
    d.source,
    d.description,
    d.commentaires,
    d.format,
    d.formatsAuto,
    d.formatResources,
    fmt
  ].flat().filter(Boolean).join(" ")).toLowerCase());

  const isOpenDataSoft = /opendatasoft|data\.toulouse-metropole\.fr|open\s*data\s*toulouse|toulouse\s*metropole/.test(text);

  // API : endpoint direct, mention API, ou plateforme connue qui expose une API.
  const hasApi =
    isOpenDataSoft ||
    /(^|[^a-z])api([^a-z]|$)/.test(text) ||
    /\/api\//.test(text) ||
    /api\./.test(text) ||
    /format\s*:??\s*(json|geojson)/.test(text);

  // Téléchargement : dès qu’un format de fichier est détecté, ou plateforme OpenDataSoft
  // qui propose un onglet Export/Téléchargement.
  const hasDownload =
    isOpenDataSoft ||
    (fmt && fmt.length > 0) ||
    /\.(csv|json|geojson|zip|xlsx|xls|parquet|gpkg|shp|kml|xml)(\?|#|$|\s|[)"'])/i.test(text) ||
    /\b(csv|json|geojson|zip|xlsx|xls|excel|parquet|gpkg|geopackage|shp|shapefile|kml|xml)\b/i.test(text);

  // Les deux modes sont comptés indépendamment.
  // Un même dataset peut donc incrémenter à la fois « API » et « Téléchargement ».
  if(hasApi) modes.push("API");
  if(hasDownload) modes.push("Téléchargement");

  return [...new Set(modes)];
}

/** Rôle : Assure le traitement associé à « count by ». */
function countBy(list){return list.filter(Boolean).reduce((a,v)=>(a[v]=(a[v]||0)+1,a),{});}
/** Rôle : Assure le traitement associé à « all values ». */
function allValues(key){return [...new Set(datasets.flatMap(d=>Array.isArray(d[key])?d[key]:[d[key]]).filter(v=>v!==undefined && v!==null && v!==""))];}
/** Rôle : Assure le traitement associé à « exact cloud terms for dataset ». */
function exactCloudTermsForDataset(d){
  // Source unique de vérité pour tous les compteurs de mots-clés du catalogue.
  // Un mot donné compte au maximum une fois par dataset, même s’il apparaît
  // dans plusieurs champs (tag, titre, description, attributs, etc.).
  return new Set(
    [...(d.tags || []), ...(d.cloudTerms || [])]
      .map(canonicalKeyword)
      .filter(Boolean)
  );
}
/** Rôle : Assure le traitement associé à « keyword stats ». */
function keywordStats(){
  const map = {};
  datasets.forEach(d => {
    const lm = normalizeLastModified(d.lastModified || d.derniereMaj);
    exactCloudTermsForDataset(d).forEach(t => {
      if(!map[t]) map[t] = {tag:t, count:0, modified:"0000-00-00"};
      map[t].count++;
      if(lm > map[t].modified) map[t].modified = lm;
    });
  });
  return Object.values(map);
}
/** Rôle : Assure le traitement associé à « sort items ». */
function sortItems(items, mode, prop="tag"){
  return [...items].sort((a,b)=> mode==="za" ? b[prop].localeCompare(a[prop]) : mode==="size" ? b.count-a.count || a[prop].localeCompare(b[prop]) : mode==="modified" ? b.modified.localeCompare(a.modified) : a[prop].localeCompare(b[prop]));
}
/** Rôle : Assure le traitement associé à « checked values ». */
function checkedValues(name){return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(x=>x.value);}
/** Rôle : Assure le traitement associé à « matches any ». */
function matchesAny(arr, selected){arr = toArray(arr); return !selected.length || selected.some(v=>arr.includes(v));}
/** Rôle : Assure le traitement associé à « sort label ». */
function sortLabel(mode){return mode==="az"?"A-Z":mode==="za"?"Z-A":mode==="size"?"Taille":"Last modified";}
/** Rôle : Échappe les caractères HTML afin d'éviter une insertion non sûre. */
function escapeHtml(value){return String(value ?? "").replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

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
  "meteopole","météopole","latitude","lat","longitude","lon","long","meme","même","mons","pty","basemap","jawg","activite_copie","activitecopie","copie","jory","juin","janvier","fevrier","février","mars","avril","mai","juillet","aout","août","septembre","octobre","novembre","decembre","décembre","salade","david","soupetard","nakache","labo","test"
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
  /^id[-_]?.*/, /^num[-_]?.*/, /^lib[-_]?.*/, /^cod[-_]?.*/, /^code$/, /^field\d*$/, /^x_?.*/, /^y_?.*/,
  /^grd$/, /^sot$/, /^d$/, /^l$/, /^no\d+$/, /^\d{5,}$/
];
/** Rôle : Nettoie un texte avant l'extraction des termes du nuage. */
function prepareCloudText(value){
  return stripAccents(String(value || "").toLowerCase())
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
  if(key0.startsWith("non_classe") || /^non_?classe/.test(key0)) return "";
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


const CLOUD_KEYWORD_GROUPS = {
  localisation: ["localisation", "GeoPoint", "GeoShape"],
  meteo: ["météo", "station_meteo"],
  quartier: ["quartier", "IRIS", "Avenue", "Rue", "Boulevard", "Place", "Impasse", "Chemin", "Grands_quartiers"],
  mobilite_douce: ["mobilité_douce", "Vélo", "VélôToulouse"],
  espace_public: ["Espace public", "espace_public", "espaces_publics"],
  education: ["Éducation", "École", "Scolaire", "Diplôme", "Maternelles", "Établissement"]
};

/** Rôle : Assure le traitement associé à « cloud group key ». */
function cloudGroupKey(value){
  return stripAccents(String(value || "").toLowerCase())
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Rôle : Assure le traitement associé à « canonical keyword ». */
function canonicalKeyword(value){
  return normalizeTagValue(value);
}

/** Rôle : Assure le traitement associé à « keyword members ». */
function keywordMembers(value){
  const group = CLOUD_KEYWORD_GROUPS[cloudGroupKey(value)];
  const source = group || [value];
  return [...new Set(source.map(canonicalKeyword).filter(Boolean))];
}

/** Rôle : Assure le traitement associé à « dataset has cloud keyword ». */
function datasetHasCloudKeyword(d, keyword){
  // Ici, les mots parents ont déjà été développés en composantes lors du
  // passage depuis le nuage. On compte donc chaque composante séparément.
  // Cela évite notamment que « météo » soit confondu avec le groupe parent
  // « Météo » et qu’il récupère aussi les datasets de station_meteo.
  const exactKeyword = canonicalKeyword(keyword);
  if(!exactKeyword) return false;
  return exactCloudTermsForDataset(d).has(exactKeyword);
}

/** Rôle : Assure le traitement associé à « count datasets for keyword ». */
function countDatasetsForKeyword(keyword){
  // Même moteur que keywordStats() : 1 occurrence maximum du mot exact
  // par dataset, sur l’ensemble des champs recherchables.
  return datasets.filter(d => datasetHasCloudKeyword(d, keyword)).length;
}

/** Rôle : Assure le traitement associé à « expand cloud keyword selection ». */
function expandCloudKeywordSelection(values){
  // Un mot parent est remplacé par ses vrais membres dans le catalogue.
  // Exemple : Localisation devient exactement localisation, GeoPoint, GeoShape.
  const result = [];
  const add = value => {
    const clean = canonicalKeyword(value);
    if(clean && !result.includes(clean)) result.push(clean);
  };
  (Array.isArray(values) ? values : []).forEach(value => {
    const group = CLOUD_KEYWORD_GROUPS[cloudGroupKey(value)];
    if(group) group.forEach(add);
    else add(value);
  });
  return result;
}

/** Rôle : Charge cloud keywords from storage. */
function loadCloudKeywordsFromStorage(){
  try{
    const saved = JSON.parse(localStorage.getItem("selectedCloudKeywords") || "[]");
    if(Array.isArray(saved)) selectedKeywords = expandCloudKeywordSelection(saved);
  }catch(e){
    selectedKeywords = [];
  }
}
/** Rôle : Assure le traitement associé à « save cloud keywords to storage ». */
function saveCloudKeywordsToStorage(){
  selectedKeywords = expandCloudKeywordSelection(selectedKeywords);
  localStorage.setItem("selectedCloudKeywords", JSON.stringify(selectedKeywords));
}
/** Rôle : Assure le traitement associé à « clear cloud keywords storage ». */
function clearCloudKeywordsStorage(){
  localStorage.removeItem("selectedCloudKeywords");
}

/** Rôle : Met à jour keyword search from selection. */
function updateKeywordSearchFromSelection(){
  if(!keywordSearch) return;
  keywordSearch.value = selectedKeywords.join(" ");
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
  if(!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
/** Rôle : Normalise la date de dernière modification d'un jeu de données. */
function normalizeLastModified(value){
  const d = parseDate(value);
  return d ? dateToIso(d) : "0000-00-00";
}
/** Rôle : Assure le traitement associé à « month start ». */
function monthStart(year, monthIndex){return new Date(year, monthIndex, 1);}
/** Rôle : Assure le traitement associé à « month end ». */
function monthEnd(year, monthIndex){return new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);}
/** Rôle : Assure le traitement associé à « coverage bounds ». */
function coverageBounds(d){
  const start = parseDate(d.dateDebut || d.startDate || d.date_debut);
  const end = parseDate(d.dateFin || d.endDate || d.date_fin);
  if(!start && !end) return null;
  return {start: start || end, end: end || start};
}
/** Rôle : Assure le traitement associé à « dataset covers year ». */
function datasetCoversYear(d, year){
  const b = coverageBounds(d); if(!b) return false;
  return b.start <= new Date(year, 11, 31, 23, 59, 59, 999) && b.end >= new Date(year, 0, 1);
}
/** Rôle : Assure le traitement associé à « dataset covers month ». */
function datasetCoversMonth(d, year, monthName){
  const b = coverageBounds(d); if(!b) return false;
  const mi = monthsOrder.indexOf(monthName);
  if(mi < 0) return false;
  return b.start <= monthEnd(year, mi) && b.end >= monthStart(year, mi);
}
/** Rôle : Assure le traitement associé à « covered months by year ». */
function coveredMonthsByYear(d){
  const b = coverageBounds(d);
  if(!b) return {};
  const out = {};
  let y = b.start.getFullYear();
  const endY = b.end.getFullYear();
  while(y <= endY){
    const months = monthsOrder.filter(m => datasetCoversMonth(d, y, m));
    if(months.length) out[y] = months;
    y++;
  }
  return out;
}
/** Rôle : Assure le traitement associé à « global time index ». */
function globalTimeIndex(){
  const index = {};
  datasets.forEach(d => {
    const byYear = coveredMonthsByYear(d);
    Object.entries(byYear).forEach(([year, months]) => {
      if(!index[year]) index[year] = new Set();
      months.forEach(m => index[year].add(m));
    });
  });
  return Object.fromEntries(Object.entries(index).map(([y,set]) => [y, monthsOrder.filter(m => set.has(m))]));
}

/** Rôle : Affiche selected keyword bar. */
function renderSelectedKeywordBar(){
  const bar = $("selectedKeywordBar");
  if(!selectedKeywords.length){
    bar.classList.add("hidden");
    $("selectedKeywordChips").innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  $("selectedKeywordChips").innerHTML = selectedKeywords.map(k =>
    `<button class="selected-chip" data-remove-keyword="${escapeHtml(k)}">${escapeHtml(k)}<strong>${countDatasetsForKeyword(k)}</strong><span>×</span></button>`
  ).join("");
  document.querySelectorAll("[data-remove-keyword]").forEach(btn => btn.onclick = () => {
    selectedKeywords = selectedKeywords.filter(k => k !== btn.dataset.removeKeyword);
    saveCloudKeywordsToStorage();
    updateKeywordSearchFromSelection();
    renderKeywords();
    filterDatasets();
  });
}

/** Rôle : Affiche keywords. */
function renderKeywords(){
  const q = keywordSearch.value;
  const items = sortItems(keywordStats().filter(k => keywordMatchesSearch(k.tag, q)), keywordSortValue);
  $("keywordCount").textContent = `${items.length} mot(s)-clé(s)`;
  $("keywordList").innerHTML = items.map(k=>`<button class="chip ${selectedKeywords.includes(k.tag)?'active':''}" data-keyword="${escapeHtml(k.tag)}">${escapeHtml(k.tag)}<strong>${k.count}</strong></button>`).join("");
  document.querySelectorAll("[data-keyword]").forEach(btn=>btn.onclick=()=>{
    const kw = btn.dataset.keyword;
    selectedKeywords = selectedKeywords.includes(kw) ? selectedKeywords.filter(k => k !== kw) : [...selectedKeywords, kw];
    saveCloudKeywordsToStorage();
    updateKeywordSearchFromSelection();
    renderKeywords();
    filterDatasets();
  });
  renderSelectedKeywordBar();
}
/** Rôle : Affiche checkboxes. */
function renderCheckboxes(containerId, name, values, counts){
  $(containerId).innerHTML = values.map(v=>`<label class="check-item" data-filter-name="${name}" data-filter-value="${escapeHtml(v)}"><input type="checkbox" name="${name}" value="${escapeHtml(v)}"> ${escapeHtml(v)}<span class="count">${counts[v]||0}</span></label>`).join("");
  document.querySelectorAll(`input[name="${name}"]`).forEach(el=>el.addEventListener("change",filterDatasets));
}
/** Rôle : Affiche tags. */
function renderTags(){
  const q = tagSearch.value;
  const items = sortItems(keywordStats().filter(k => keywordMatchesSearch(k.tag, q)), tagSortValue);
  $("tagList").innerHTML = items.map(k=>`<label class="check-item" data-filter-name="tags" data-filter-value="${escapeHtml(k.tag)}"><input type="checkbox" name="tags" value="${escapeHtml(k.tag)}"> ${escapeHtml(k.tag)}<span class="count">${k.count}</span></label>`).join("");
  document.querySelectorAll('input[name="tags"]').forEach(el=>el.addEventListener("change",filterDatasets));
}
/** Rôle : Récupère year extent. */
function getYearExtent(){
  const bounds = datasets.map(coverageBounds).filter(Boolean);
  if(!bounds.length) return null;
  const minYear = Math.min(...bounds.map(b => b.start.getFullYear()));
  const maxYear = Math.max(...bounds.map(b => b.end.getFullYear()));
  return {minYear, maxYear};
}
/** Rôle : Assure le traitement associé à « clamp year ». */
function clampYear(value){
  const n = Number(value);
  if(!Number.isFinite(n)) return timeYearMin;
  return Math.min(timeYearMax, Math.max(timeYearMin, Math.round(n)));
}
/** Rôle : Assure le traitement associé à « selected year range ». */
function selectedYearRange(){
  const startSlider = $("timeStartYearSlider");
  const endSlider = $("timeEndYearSlider");
  const startInput = $("timeStartYearInput");
  const endInput = $("timeEndYearInput");
  if(!startSlider || !endSlider) return null;

  let startYear = clampYear(startSlider.value);
  let endYear = clampYear(endSlider.value);

  if(startYear > endYear){
    if(document.activeElement === startSlider || document.activeElement === startInput){
      endYear = startYear;
    }else{
      startYear = endYear;
    }
  }

  startSlider.value = String(startYear);
  endSlider.value = String(endYear);
  if(startInput) startInput.value = String(startYear);
  if(endInput) endInput.value = String(endYear);

  return {startYear, endYear};
}
/** Rôle : Met à jour time slider labels. */
function updateTimeSliderLabels(){
  const range = selectedYearRange();
  if(!range) return;

  timeFilterStartYear = range.startYear;
  timeFilterEndYear = range.endYear;

  const startValue = $("timeStartYearValue");
  const endValue = $("timeEndYearValue");
  if(startValue) startValue.textContent = String(range.startYear);
  if(endValue) endValue.textContent = String(range.endYear);

  const sliderWrap = $("timeDualSlider");
  if(sliderWrap && timeYearMax > timeYearMin){
    const startPct = ((range.startYear - timeYearMin) / (timeYearMax - timeYearMin)) * 100;
    const endPct = ((range.endYear - timeYearMin) / (timeYearMax - timeYearMin)) * 100;
    sliderWrap.style.setProperty("--start", `${startPct}%`);
    sliderWrap.style.setProperty("--end", `${endPct}%`);
  }
}
/** Rôle : Assure le traitement associé à « dataset overlaps year range ». */
function datasetOverlapsYearRange(d, startYear, endYear){
  const b = coverageBounds(d);
  if(!b) return !timeFilterActive;
  return b.start.getFullYear() <= endYear && b.end.getFullYear() >= startYear;
}
/** Rôle : Affiche time. */
function renderTime(){
  const extent = getYearExtent();
  if(!extent){
    timeYearMin = null;
    timeYearMax = null;
    timeFilterStartYear = null;
    timeFilterEndYear = null;
    timeFilterActive = false;
    $("timeList").innerHTML = `<p class="empty-state">Aucune date de couverture renseignée.</p>`;
    return;
  }

  timeYearMin = extent.minYear;
  timeYearMax = extent.maxYear;

  $("timeList").innerHTML = `
    <div class="year-slider-filter">
      <p class="time-help">Définis une période avec une seule barre à deux curseurs. Tu peux aussi saisir directement les années dans les cases.</p>

      <div class="time-range-summary two-cols">
        <label class="year-input-card" for="timeStartYearInput">
          <span>Année de début</span>
          <input id="timeStartYearInput" class="year-number-input" type="number" min="${timeYearMin}" max="${timeYearMax}" value="${timeYearMin}" step="1" inputmode="numeric" aria-label="Année de début">
        </label>
        <label class="year-input-card" for="timeEndYearInput">
          <span>Année de fin</span>
          <input id="timeEndYearInput" class="year-number-input" type="number" min="${timeYearMin}" max="${timeYearMax}" value="${timeYearMax}" step="1" inputmode="numeric" aria-label="Année de fin">
        </label>
      </div>

      <div class="year-slider-row">
        <label>Période couverte</label>
        <div id="timeDualSlider" class="dual-range-slider">
          <input id="timeStartYearSlider" class="year-slider year-slider-min" type="range" min="${timeYearMin}" max="${timeYearMax}" value="${timeYearMin}" step="1" aria-label="Année de début">
          <input id="timeEndYearSlider" class="year-slider year-slider-max" type="range" min="${timeYearMin}" max="${timeYearMax}" value="${timeYearMax}" step="1" aria-label="Année de fin">
        </div>
        <div class="time-scale"><span>${timeYearMin}</span><span>${timeYearMax}</span></div>
      </div>

      <button id="resetTimeBtn" class="mini-reset" type="button">Réinitialiser la période</button>
    </div>`;

  [$("timeStartYearSlider"), $("timeEndYearSlider")].forEach(el => {
    el.addEventListener("input", () => {
      timeFilterActive = true;
      updateTimeSliderLabels();
      filterDatasets();
    });
  });

  /** Rôle : Applique year input. */
  function applyYearInput(el, {commit = false} = {}){
    const raw = String(el.value).trim();

    // Pendant la saisie au clavier, on laisse l'utilisateur écrire librement
    // (ex. passer de 1949 à 2020 sans être immédiatement ramené à 1949).
    if(raw === "") return;

    const isCompleteYear = /^\d{4}$/.test(raw);
    if(!commit && !isCompleteYear) return;

    const year = clampYear(raw);
    const startSlider = $("timeStartYearSlider");
    const endSlider = $("timeEndYearSlider");

    timeFilterActive = true;
    if(el.id === "timeStartYearInput") startSlider.value = String(year);
    if(el.id === "timeEndYearInput") endSlider.value = String(year);

    updateTimeSliderLabels();
    filterDatasets();
  }

  [$("timeStartYearInput"), $("timeEndYearInput")].forEach(el => {
    el.addEventListener("input", () => applyYearInput(el));
    el.addEventListener("keydown", (event) => {
      if(event.key === "Enter"){
        event.preventDefault();
        applyYearInput(el, {commit: true});
        el.blur();
      }
    });
    el.addEventListener("blur", () => applyYearInput(el, {commit: true}));
  });

  $("resetTimeBtn").onclick = () => {
    timeFilterActive = false;
    $("timeStartYearSlider").value = String(timeYearMin);
    $("timeEndYearSlider").value = String(timeYearMax);
    $("timeStartYearInput").value = String(timeYearMin);
    $("timeEndYearInput").value = String(timeYearMax);
    updateTimeSliderLabels();
    filterDatasets();
  };

  updateTimeSliderLabels();
}
/** Rôle : Assure le traitement associé à « populate ». */
function populate(){
  renderKeywords(); renderTags(); renderTime();
  renderCheckboxes("geoList","geo",allValues("geo").sort(),countBy(datasets.flatMap(d=>toArray(d.geo))));
  renderCheckboxes("publisherList","publisher",allValues("publisher").sort(),countBy(datasets.map(d=>d.publisher)));
  renderCheckboxes("natureList","nature",allValues("nature").sort(),countBy(datasets.map(d=>d.nature)));
  const formatCounts = countBy(datasets.flatMap(d=>d.formats || []));
  const availableFormats = Object.keys(formatCounts).sort((a,b) => {
    const ia = SUPPORTED_FORMATS.indexOf(a), ib = SUPPORTED_FORMATS.indexOf(b);
    if(ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });
  renderCheckboxes("formatList","format",availableFormats,formatCounts);

  const exportCounts = countBy(datasets.flatMap(d => d.exportModes || []));
  // Chaque compteur représente tous les datasets proposant ce mode.
  // Un dataset proposant les deux modes est compté dans les deux cases.
  const availableExports = ["API", "Téléchargement"];
  renderCheckboxes("exportList","exportMode",availableExports,exportCounts);

  $("totalDatasets").textContent = datasets.length;
}
/** Rôle : Assure le traitement associé à « filtered datasets ». */
function filteredDatasets(){
  const state = currentFilterState();
  return datasets.filter(d => datasetMatchesState(d, state))
    .sort((a,b)=> datasetSort.value==="az" ? a.title.localeCompare(b.title) : datasetSort.value==="za" ? b.title.localeCompare(a.title) : normalizeLastModified(b.lastModified || b.derniereMaj).localeCompare(normalizeLastModified(a.lastModified || a.derniereMaj)));
}
/** Rôle : Assure le traitement associé à « current filter state ». */
function currentFilterState(){
  return {
    query: searchInput.value.toLowerCase().trim(),
    tags: checkedValues("tags"),
    geos: checkedValues("geo"),
    publishers: checkedValues("publisher"),
    natures: checkedValues("nature"),
    formats: checkedValues("format"),
    exportModes: checkedValues("exportMode"),
    activeYearRange: timeFilterActive ? selectedYearRange() : null
  };
}
/** Rôle : Assure le traitement associé à « dataset matches state ». */
function datasetMatchesState(d, state){
  const searchable = Object.values(d).flat().join(" ").toLowerCase();
  const timeOk = !state.activeYearRange || datasetOverlapsYearRange(d, state.activeYearRange.startYear, state.activeYearRange.endYear);
  return searchable.includes(state.query)
    && (!selectedKeywords.length || selectedKeywords.some(k => datasetHasCloudKeyword(d, k)))
    && matchesAny(d.tags||[], state.tags)
    && matchesAny(d.geo, state.geos)
    && timeOk
    && (!state.publishers.length || state.publishers.includes(d.publisher))
    && (!state.natures.length || state.natures.includes(d.nature))
    // À l’intérieur de la catégorie Format, les choix sont combinés avec OU.
    // Exemple : CSV + JSON affiche les datasets disponibles en CSV OU en JSON.
    && (!state.formats.length || state.formats.some(f => (d.formats || []).includes(f)))
    && (!state.exportModes.length || state.exportModes.some(m => (d.exportModes || []).includes(m)));
}
/** Rôle : Assure le traitement associé à « count with candidate ». */
function countWithCandidate(group, value){
  const state = currentFilterState();

  // Comptage disjonctif (OU) à l’intérieur d’une même catégorie :
  // pour calculer le nombre affiché à côté d’une option, on conserve tous les
  // filtres des AUTRES catégories, mais on ignore les sélections déjà actives
  // dans la catégorie courante et on teste uniquement l’option concernée.
  //
  // Exemple : si « Statique » est coché, le compteur de « Dynamique » reste
  // le nombre de datasets dynamiques compatibles avec les autres catégories ;
  // il ne devient pas le total « Statique OU Dynamique ».
  if(group === "tags") state.tags = [value];
  if(group === "geo") state.geos = [value];
  if(group === "publisher") state.publishers = [value];
  if(group === "nature") state.natures = [value];
  if(group === "format") state.formats = [value];
  if(group === "exportMode") state.exportModes = [value];

  return datasets.filter(d => datasetMatchesState(d, state)).length;
}
/** Rôle : Met à jour dynamic filter counts. */
function updateDynamicFilterCounts(){
  const groups = ["tags", "geo", "publisher", "nature", "format", "exportMode"];

  groups.forEach(group => {
    document
      .querySelectorAll(`label[data-filter-name="${group}"]`)
      .forEach(label => {
        const input = label.querySelector('input[type="checkbox"]');
        const countEl = label.querySelector('.count');

        if(!input || !countEl) return;

        // Chaque compteur est recalculé à partir de l'état courant des filtres.
        // Ainsi, les formats se mettent aussi à jour après une sélection
        // d'exportation, de période, de producteur, de zone, etc.
        const n = countWithCandidate(group, input.value);
        countEl.textContent = n;

        // Toutes les options restent visibles, même lorsqu'elles valent 0.
        label.style.display = "";
      });
  });
}
/** Rôle : Formate la période temporelle d'un jeu de données pour l'affichage. */
function formatPeriod(d){
  const start = d.dateDebut || "";
  const end = d.dateFin || "";
  if(start || end) return `${start || "?"} → ${end || "?"}`;
  return d.periode || "Non renseigné";
}
// Portails historiquement traités sans préfixe (compatibilité avec tout ce qui
// est câblé en dur ailleurs dans l'app et côté serveur : historique, exceptions...).
const LEGACY_ODS_DOMAINS = ["data.toulouse-metropole.fr", "toulouse-metropole.opendatasoft.com"];

/** Rôle : Extrait le domaine et le slug OpenDataSoft depuis les métadonnées du jeu. */
function extractOpenDataSoftReference(d){
  const candidates = [d.url, d.urlLabel, d.description]
    .map(value => String(value || ""))
    .filter(Boolean);

  const patterns = [
    /https?:\/\/([^/]+)\/api\/explore\/v2(?:\.1)?\/catalog\/datasets\/([^/?#]+)(?:\/records)?/i,
    /https?:\/\/([^/]+)\/explore\/dataset\/([^/?#]+)/i,
    /https?:\/\/([^/]+)\/catalog\/datasets\/([^/?#]+)(?:\/records)?/i
  ];

  for(const candidate of candidates){
    for(const pattern of patterns){
      const match = candidate.match(pattern);
      if(match) return {domain: match[1].toLowerCase(), slug: decodeURIComponent(match[2]).toLowerCase()};
    }
  }
  return null;
}

/** Rôle : Construit l'identifiant utilisable par le serveur pour un jeu OpenDataSoft. */
function extractOpenDataSoftDatasetId(d){
  const ref = extractOpenDataSoftReference(d);
  if(!ref) return "";
  // Toulouse Métropole garde un identifiant simple ; tout autre portail
  // OpenDataSoft (ex. data.haute-garonne.fr) est préfixé par son domaine pour
  // que le serveur sache vers quelle API interroger.
  if(LEGACY_ODS_DOMAINS.includes(ref.domain)) return ref.slug;
  return `ods::${ref.domain}::${ref.slug}`;
}

/** Rôle : Extrait l'identifiant data.gouv.fr à partir des liens et métadonnées disponibles. */
function extractDataGouvDatasetId(d){
  const candidates = [d.url, d.urlLabel, d.description]
    .map(value => String(value || ""))
    .filter(Boolean);

  for(const candidate of candidates){
    const match = candidate.match(/data\.gouv\.fr\/(?:fr\/)?datasets\/([^/?#]+)/i);
    if(match){
      const identifier = decodeURIComponent(match[1]);
      if(/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(identifier)){
        return `datagouv--${identifier}`;
      }
    }
  }
  return "";
}

/** Rôle : Indique si le jeu courant est une ressource data.gouv.fr. */
function isDataGouvDataset(d){
  const text = stripAccents(String([
    d.publisher, d.source, d.url, d.urlLabel, d.description
  ].filter(Boolean).join(" ")).toLowerCase());
  return /data\.gouv\.fr|data\s*gouv\s*fr/.test(text);
}

/** Rôle : Vérifie si les ressources data.gouv.fr suggèrent la présence d'un format géographique. */
function hasDataGouvSpatialResourceHint(d){
  const formats = [
    ...(Array.isArray(d.formats) ? d.formats : []),
    ...(Array.isArray(d.formatsAuto) ? d.formatsAuto : []),
    ...(Array.isArray(d.formatResources) ? d.formatResources : []),
    d.format, d.url, d.urlLabel, d.description, d.geometry
  ].flat().filter(Boolean).join(" ").toLowerCase();
  return /geojson|gpkg|geopackage|shapefile|\bshp\b|\bkml\b|latitude|longitude|geopoint|geoshape/.test(formats);
}

/** Rôle : Indique si le jeu courant est géré comme un jeu OpenDataSoft. */
function isOpenDataSoftDataset(d){
  // N'importe quel portail bâti sur OpenDataSoft (Toulouse Métropole, Haute-Garonne,
  // ou un autre à l'avenir) est reconnu dès que l'URL a la forme d'une fiche/API ODS.
  return Boolean(extractOpenDataSoftReference(d));
}

/** Rôle : Retourne l'identifiant technique à transmettre à la page de visualisation. */
function getVisualizationDatasetId(d){
  const title = String(d.title || "").toLowerCase();
  const description = String(d.description || "").toLowerCase();
  const text = `${title} ${description}`;

  // Les deux fichiers GeoJSON locaux conservent leur configuration dédiée.
  if(text.includes("zones de rencontre") || (text.includes("rencontre") && text.includes("toulouse"))){
    return "zones-de-rencontre";
  }
  if(text.includes("espaces verts") || text.includes("espace vert")){
    return "espaces-verts";
  }
  if(text.includes("contours iris") || (text.includes("iris") && text.includes("contours"))){
    return "contours-iris";
  }
  if(title.includes("bd topo") || title === "bd-topo"){
    return "bd-topo";
  }
  // La fiche data.gouv.fr « Aires de jeux - Toulouse » est un miroir du jeu
  // Open Data Toulouse. Utiliser directement l'identifiant ODS évite de dépendre
  // d'une ressource data.gouv temporairement indisponible ou mal typée.
  if(title.includes("aires de jeux") && (text.includes("toulouse") || isDataGouvDataset(d))){
    return "aires-de-jeux";
  }

  // Pour data.gouv.fr, Flask interroge automatiquement la fiche du dataset,
  // choisit la meilleure ressource (GeoJSON, GPKG, SHP/ZIP, CSV ou JSON),
  // la télécharge et la conserve dans un cache local.
  const dataGouvId = extractDataGouvDatasetId(d);
  if(dataGouvId && isDataGouvDataset(d) && (hasGeometry(d) || hasDataGouvSpatialResourceHint(d))){
    return dataGouvId;
  }

  // Pour Open Data Toulouse, l'identifiant est récupéré automatiquement depuis
  // l'URL de la fiche ou de l'API. Il n'est plus nécessaire de déclarer chaque
  // dataset individuellement dans app.py.
  const automaticId = extractOpenDataSoftDatasetId(d);
  // Un format GEOJSON proposé par la plateforme ne prouve pas, à lui seul,
  // que ce dataset contient réellement une géométrie. On exige donc un signal
  // géographique positif dans les métadonnées du catalogue.
  if(automaticId && isOpenDataSoftDataset(d) && hasGeometry(d)){
    return automaticId;
  }

  // Compatibilité avec les anciennes lignes du Google Sheet dont l'URL réelle
  // n'était pas encore remontée par Apps Script.
  if(text.includes("comptages routiers") && text.includes("2025")){
    return "comptages-routiers-et-pietons-2025";
  }
  if((title.includes("velotoulouse") || title.includes("vélôtoulouse")) &&
     title.includes("localisation") &&
     (title.includes("caracteristique") || title.includes("caractéristique"))){
    return "velotoulouse-localisation-et-caracteristique-des-stations";
  }
  if(text.includes("parcs de stationnement") || text.includes("parc de stationnement")){
    return "parcs-de-stationnement";
  }

  return "";
}
/** Rôle : Détermine l'action spatiale disponible : visualisation directe, diagnostic ou jointure. */
function getSpatialAction(d){
  const datasetId = getVisualizationDatasetId(d);
  if(datasetId){
    return {type:"map", datasetId, label:"🗺️ Visualiser sur la carte", className:"visualize-btn"};
  }

  // Recensement Population : CSV local sans géométrie propre — le repérage
  // se fait via le code IRIS, donc on propose le diagnostic/jointure plutôt
  // que le bouton "visualiser directement" (qui n'afficherait rien).
  const title = String(d.title || "").toLowerCase();
  const recensementMatch = title.match(/^recensement population (\d{4})$/);
  if(recensementMatch){
    return {
      type:"diagnostic",
      datasetId:`recensement-population-${recensementMatch[1]}`,
      label:"🔎 Analyser le potentiel spatial (jointure IRIS requise)",
      className:"spatial-diagnostic-btn"
    };
  }

  const automaticId = extractOpenDataSoftDatasetId(d);
  if(automaticId && isOpenDataSoftDataset(d)){
    return {type:"diagnostic", datasetId:automaticId, label:"🔎 Analyser le potentiel spatial", className:"spatial-diagnostic-btn"};
  }

  const dataGouvId = extractDataGouvDatasetId(d);
  if(dataGouvId && isDataGouvDataset(d)){
    return {
      type:"diagnostic",
      datasetId:dataGouvId,
      label:"🔎 Découvrir les ressources data.gouv.fr",
      className:"spatial-diagnostic-btn"
    };
  }

  return null;
}
/** Rôle : Vérifie si un jeu peut être affiché directement sur la carte. */
function isVisualisableDataset(d){
  return getSpatialAction(d)?.type === "map";
}
/** Rôle : Ouvre la page de diagnostic spatial du jeu sélectionné. */
function openSpatialDiagnostic(d){
  const action = getSpatialAction(d);
  if(!action || !action.datasetId){
    alert("Aucun identifiant de source exploitable n’a été détecté pour ce dataset.");
    return;
  }
  const params = new URLSearchParams({dataset: action.datasetId, title: d.title || action.datasetId});
  window.location.href = `/diagnostic-spatial?${params.toString()}`;
}
/** Rôle : Demande au serveur le meilleur référentiel proposé pour joindre le jeu sélectionné. */
async function resolveBestJoinCandidate(datasetId){
  const response = await fetch(`/api/spatial-diagnostic/${encodeURIComponent(datasetId)}`);
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const candidates = data.join_candidates || [];
  return candidates.find(c => c.verified_by_values) || null;
}
/** Rôle : Ajoute ou retire un jeu et son référentiel recommandé de la sélection cartographique. */
async function toggleJoinMapDataset(d, checked, inputEl){
  const action = getSpatialAction(d);
  if(!action || action.type !== "diagnostic") return;
  const id = action.datasetId;
  if(!checked){
    selectedMapDatasets.delete(id);
    document.querySelectorAll(`input[data-map-select-id="${CSS.escape(id)}"]`).forEach(input => { input.checked = false; });
    updateMapSelectionBar();
    return;
  }
  // Etat optimiste pendant la résolution de la jointure automatique.
  selectedMapDatasets.set(id, {id, title: d.title || id, resolvingJoin: true});
  updateMapSelectionBar();
  try{
    const best = await resolveBestJoinCandidate(id);
    if(!best){
      selectedMapDatasets.delete(id);
      if(inputEl) inputEl.checked = false;
      alert("Aucune jointure fiable n’a été confirmée automatiquement pour ce dataset : impossible de l’ajouter au croisement cartographique.");
      updateMapSelectionBar();
      return;
    }
    selectedMapDatasets.set(id, {
      id,
      title: d.title || id,
      join: {
        referenceTarget: best.dataset_id,
        referenceTitle: best.title,
        sourceField: best.source_field || "",
        targetField: best.target_field || ""
      }
    });
  }catch(error){
    console.error("Impossible de résoudre la jointure automatique.", error);
    selectedMapDatasets.delete(id);
    if(inputEl) inputEl.checked = false;
    alert("Impossible de résoudre la jointure automatique pour ce dataset.");
  }
  updateMapSelectionBar();
}
/** Rôle : Ouvre la carte avec le jeu de données sélectionné. */
function visualizeDataset(d){
  const datasetId = getVisualizationDatasetId(d);
  if(!datasetId){
    alert("Ce dataset ne possède pas de source cartographique ou de géométrie détectable.");
    return;
  }
  const params = new URLSearchParams({dataset: datasetId, title: d.title || datasetId});
  window.location.href = `/carte?${params.toString()}`;
}
/** Rôle : Construit une clé stable pour identifier un jeu dans la sélection de la carte. */
function mapSelectionKey(d){
  return getVisualizationDatasetId(d) || "";
}
/** Rôle : Met à jour la barre récapitulative des jeux sélectionnés pour la carte. */
function updateMapSelectionBar(){
  const bar = $("mapSelectionBar");
  const count = selectedMapDatasets.size;
  if(!bar) return;
  bar.classList.toggle("hidden", count === 0);
  $("mapSelectionCount").textContent = count;
  const resolving = [...selectedMapDatasets.values()].some(item => item.resolvingJoin);
  $("mapSelectionNames").textContent = count
    ? (resolving
        ? "Résolution de la jointure automatique en cours..."
        : [...selectedMapDatasets.values()].map(item => item.title).join(" · "))
    : "Choisis les jeux à superposer.";
  // Empêche de confirmer tant qu'une jointure automatique est encore en cours
  // de résolution (appel réseau asynchrone) : sans ce garde-fou, un clic trop
  // rapide envoie le dataset vers la carte sans ses informations de jointure,
  // et il apparaît alors comme n'ayant aucune géométrie exploitable.
  if(confirmMapSelectionBtn){
    confirmMapSelectionBtn.disabled = resolving;
    confirmMapSelectionBtn.textContent = resolving ? "Résolution en cours..." : "Confirmer et afficher sur la carte";
    confirmMapSelectionBtn.title = resolving ? "Résolution de la jointure automatique en cours..." : "";
  }
  document.querySelectorAll(".dataset-card").forEach(card => {
    const id = card.dataset.mapDatasetId || "";
    card.classList.toggle("map-selected", Boolean(id && selectedMapDatasets.has(id)));
  });
}
/** Rôle : Ajoute ou retire un jeu de données de la sélection cartographique multiple. */
function toggleMapDataset(d, checked){
  const id = mapSelectionKey(d);
  if(!id) return;
  if(checked) selectedMapDatasets.set(id, {id, title:d.title || id});
  else selectedMapDatasets.delete(id);
  document.querySelectorAll(`input[data-map-select-id="${CSS.escape(id)}"]`).forEach(input => {
    input.checked = selectedMapDatasets.has(id);
  });
  updateMapSelectionBar();
}
/** Rôle : Ouvre la carte avec l'ensemble des jeux actuellement sélectionnés. */
function openSelectedDatasetsMap(){
  const selected = [...selectedMapDatasets.values()];
  if(!selected.length) return;
  const params = new URLSearchParams();
  params.set("datasets", selected.map(item => item.id).join(","));
  params.set("titles", selected.map(item => item.title).join("||"));
  if(selected.some(item => item.join)){
    params.set("reference_targets", selected.map(item => item.join?.referenceTarget || "").join("||"));
    params.set("reference_titles", selected.map(item => item.join?.referenceTitle || "").join("||"));
    params.set("source_fields", selected.map(item => item.join?.sourceField || "").join("||"));
    params.set("target_fields", selected.map(item => item.join?.targetField || "").join("||"));
  }
  window.location.href = `/carte?${params.toString()}`;
}
/** Rôle : Génère le contenu HTML de la carte descriptive d'un jeu de données. */
function cardHTML(d,i,prefix="open"){
  const last = d.lastModified && d.lastModified !== "Non renseigné" ? d.lastModified : (d.derniereMaj || "Non renseigné");
  const spatialAction = getSpatialAction(d);
  const visualButton = spatialAction
    ? `<button class="${spatialAction.className}" data-${prefix}-spatial-index="${i}" type="button">${spatialAction.label}</button>`
    : "";
  // Pour les datasets sans géométrie directe (bouton orange "Analyser le
  // potentiel spatial"), la jointure n'est plus proposée automatiquement ici :
  // l'utilisateur choisit lui-même le référentiel sur la page de diagnostic.
  const isAutoJoinEligible = spatialAction?.type === "diagnostic" && isOpenDataSoftDataset(d);
  const mapId = spatialAction?.type === "map" ? spatialAction.datasetId : "";
  const joinMapId = isAutoJoinEligible ? spatialAction.datasetId : "";
  const selectControl = mapId
    ? `<label class="map-select-row"><input type="checkbox" data-${prefix}-map-index="${i}" data-map-select-id="${escapeHtml(mapId)}" ${selectedMapDatasets.has(mapId) ? "checked" : ""}><span>Sélectionner pour croiser sur la carte</span></label>`
    : (joinMapId
      ? `<label class="map-select-row"><input type="checkbox" data-${prefix}-joinmap-index="${i}" data-map-select-id="${escapeHtml(joinMapId)}" ${selectedMapDatasets.has(joinMapId) ? "checked" : ""}><span>Sélectionner pour croiser sur la carte (jointure auto)</span></label>`
      : "");
  const cardMapId = mapId || joinMapId;
  return `<article class="dataset-card ${cardMapId && selectedMapDatasets.has(cardMapId) ? "map-selected" : ""}" data-map-dataset-id="${escapeHtml(cardMapId)}">${selectControl}<span class="badge">${escapeHtml(d.theme)}</span><h3>${escapeHtml(d.title)}</h3><p>${escapeHtml(d.description)}</p><div class="meta"><span>${escapeHtml(d.nature)}</span><span>${escapeHtml(d.format)}</span><span>${escapeHtml(d.publisher)}</span><span>${escapeHtml((d.exportModes||[]).join(" / ") || "Export non détecté")}</span><span>MAJ : ${escapeHtml(last)}</span></div><div class="card-actions"><button class="open-btn" data-${prefix}-index="${i}" type="button">Voir la fiche</button>${visualButton}</div></article>`;
}
/** Rôle : Affiche les résultats en respectant les groupes de filtres combinés par une logique ET. */
function renderAndResults(baseItems){
  const box = $("andResults");
  if(selectedKeywords.length < 2){
    box.classList.add("hidden");
    $("andGrid").innerHTML = "";
    return;
  }
  const andItems = baseItems.filter(d => selectedKeywords.every(k => datasetHasCloudKeyword(d, k)));
  box.classList.remove("hidden");
  $("andCount").textContent = `${andItems.length} dataset(s)`;
  $("andGrid").innerHTML = andItems.length
    ? andItems.map((d,i)=>cardHTML(d,i,"and")).join("")
    : `<p class="empty-state">Aucun dataset ne contient tous ces mots-clés en même temps.</p>`;
  document.querySelectorAll("[data-and-index]").forEach(btn=>btn.onclick=()=>openModal(andItems[btn.dataset.andIndex]));
  document.querySelectorAll("[data-and-map-index]").forEach(input=>input.onchange=()=>toggleMapDataset(andItems[input.dataset.andMapIndex], input.checked));
  document.querySelectorAll("[data-and-joinmap-index]").forEach(input=>input.onchange=(e)=>toggleJoinMapDataset(andItems[input.dataset.andJoinmapIndex], e.target.checked, e.target));
  document.querySelectorAll("[data-and-spatial-index]").forEach(btn=>btn.onclick=()=>{
    const d = andItems[btn.dataset.andSpatialIndex];
    const action = getSpatialAction(d);
    if(action?.type === "map") visualizeDataset(d); else openSpatialDiagnostic(d);
  });
}
/** Rôle : Construit et insère les cartes des jeux de données dans la page. */
function renderCards(items){
  renderAndResults(items);
  grid.innerHTML = items.length
    ? items.map((d,i)=>cardHTML(d,i,"open")).join("")
    : `<p class="empty-state">Aucun dataset ne correspond aux filtres sélectionnés.</p>`;
  document.querySelectorAll("[data-open-index]").forEach(btn=>btn.onclick=()=>openModal(items[btn.dataset.openIndex]));
  document.querySelectorAll("[data-open-map-index]").forEach(input=>input.onchange=()=>toggleMapDataset(items[input.dataset.openMapIndex], input.checked));
  document.querySelectorAll("[data-open-joinmap-index]").forEach(input=>input.onchange=(e)=>toggleJoinMapDataset(items[input.dataset.openJoinmapIndex], e.target.checked, e.target));
  document.querySelectorAll("[data-open-spatial-index]").forEach(btn=>btn.onclick=()=>{
    const d = items[btn.dataset.openSpatialIndex];
    const action = getSpatialAction(d);
    if(action?.type === "map") visualizeDataset(d); else openSpatialDiagnostic(d);
  });
  const modeText = selectedKeywords.length ? "résultat(s) avec au moins un mot-clé sélectionné" : "résultat(s)";
  $("resultText").textContent = `${items.length} ${modeText}`; $("visibleDatasets").textContent = items.length;
}
/** Rôle : Applique la recherche, les filtres et le tri aux jeux de données du catalogue. */
function filterDatasets(){
  const items = filteredDatasets();
  renderCards(items);
  updateDynamicFilterCounts();
}
/** Rôle : Découpe une valeur de métadonnée contenant plusieurs éléments. */
function splitAttributeValues(value){
  return String(value || "")
    .split(/[,;\n]/)
    .map(v => v.trim())
    .filter(Boolean);
}
/** Rôle : Classe une métadonnée dans la section descriptive appropriée. */
function detectAttributeCategory(key){
  const k = String(key || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if(k.includes("geo") || k.includes("localisation") || k.includes("location")) return "Attributs de localisation";
  if(k.includes("temporel") || k.includes("date") || k.includes("time") || k.includes("started") || k.includes("ended")) return "Attributs temporels";
  if(k.includes("identification") || k.includes("identifiant") || k === "id" || k.includes("code") || k.includes("station_id")) return "Attributs d’identification";
  return "Autres attributs";
}
/** Rôle : Regroupe les métadonnées d'un jeu par catégories fonctionnelles. */
function groupedAttributes(attrs){
  const groups = {
    "Attributs de localisation": [],
    "Attributs temporels": [],
    "Attributs d’identification": [],
    "Autres attributs": []
  };

  if(!attrs) return groups;

  if(Array.isArray(attrs)){
    attrs.forEach(v => groups["Autres attributs"].push(...splitAttributeValues(v)));
    return groups;
  }

  if(typeof attrs === "object"){
    Object.entries(attrs).forEach(([key,value]) => {
      const vals = splitAttributeValues(value);
      const cat = detectAttributeCategory(key);
      if(vals.length){
        groups[cat].push(...vals);
      }
    });
    return groups;
  }

  groups["Autres attributs"].push(...splitAttributeValues(attrs));
  return groups;
}
/** Rôle : Génère l'affichage HTML des groupes de métadonnées. */
function renderAttributeGroups(attrs){
  const container = $("modalAttributs");
  const groups = groupedAttributes(attrs);
  const html = Object.entries(groups).map(([name, values]) => {
    const uniqueValues = [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
    const content = uniqueValues.length
      ? `<div class="attribute-list">${uniqueValues.map(v => `<span>${escapeHtml(v)}</span>`).join("")}</div>`
      : `<p class="empty-attr">Non renseigné</p>`;
    return `<details class="attribute-group" open>
      <summary>${escapeHtml(name)} <small>${uniqueValues.length}</small></summary>
      ${content}
    </details>`;
  }).join("");
  container.innerHTML = html;
}
/** Rôle : Vérifie qu'une valeur correspond à une URL HTTP ou HTTPS valide. */
function isValidHttpUrl(value){
  return /^https?:\/\//i.test(String(value || "").trim());
}
/** Rôle : Affiche un lien exploitable dans le champ prévu de la fiche descriptive. */
function setUrlField(url, label){
  const el = $("modalUrl");
  el.innerHTML = "";
  const cleanUrl = String(url || "").trim();
  const cleanLabel = String(label || "").trim();

  if(!cleanUrl){
    el.textContent = "Non renseigné";
    return;
  }

  // Important : si Google Sheets renvoie seulement le texte affiché du lien
  // et pas l’URL réelle, on évite de l’ouvrir comme fichier local.
  if(!isValidHttpUrl(cleanUrl)){
    el.innerHTML = `<span>${escapeHtml(cleanLabel || cleanUrl)}</span><br><small class="url-warning">Lien non disponible : redéploie Apps Script avec la version fournie pour récupérer l’hyperlien réel de Google Sheets.</small>`;
    return;
  }

  const a = document.createElement("a");
  a.href = cleanUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = cleanLabel || "Ouvrir le jeu de données";
  el.appendChild(a);
}
/** Rôle : Récupère et affiche les attributs détectés directement depuis la source du jeu. */
async function renderLiveDatasetAttributes(d){
  const datasetId = extractOpenDataSoftDatasetId(d);
  if(!datasetId || !isOpenDataSoftDataset(d)){
    renderAttributeGroups(d.attributs);
    return;
  }
  const container = $("modalAttributs");
  container.innerHTML = `<p class="empty-attr">Chargement des attributs réels depuis l’API…</p>`;
  try{
    const response = await fetch(`/api/dataset-schema/${encodeURIComponent(datasetId)}`);
    const schema = await response.json();
    if(!response.ok) throw new Error(schema.error || "Schéma indisponible");
    const labels = {
      location: "Attributs de localisation",
      temporal: "Attributs temporels",
      identification: "Attributs d’identification",
      other: "Autres attributs"
    };
    const groups = schema.categories || {};
    const fieldLabels = schema.field_labels || {};
    container.innerHTML = Object.entries(labels).map(([key, label]) => {
      const values = Array.isArray(groups[key]) ? groups[key] : [];
      const content = values.length
        ? `<div class="attribute-list">${values.map(v => {
            const readable = fieldLabels[v];
            return `<span>${escapeHtml(readable ? `${v} (${readable})` : v)}</span>`;
          }).join("")}</div>`
        : `<p class="empty-attr">Non renseigné</p>`;
      return `<details class="attribute-group" open>
        <summary>${escapeHtml(label)} <small>${values.length}</small></summary>
        ${content}
      </details>`;
    }).join("");
  }catch(error){
    // Fallback uniquement si l’API est temporairement indisponible.
    renderAttributeGroups(d.attributs);
    container.insertAdjacentHTML("afterbegin", `<p class="url-warning">Le schéma réel n’a pas pu être chargé : ${escapeHtml(error.message)}</p>`);
  }
}
/** Rôle : Ouvre et renseigne la fiche descriptive du jeu sélectionné. */
function openModal(d){
  const extra = $("modalExtraDetails");
  const moreToggle = $("modalMoreToggle");
  if(extra && moreToggle){
    extra.classList.add("hidden");
    moreToggle.setAttribute("aria-expanded", "false");
    moreToggle.querySelector("span").textContent = "Afficher tous les détails de la fiche";
    moreToggle.querySelector("strong").textContent = "▾";
  }
  $("modalTheme").textContent=d.theme || "Non classé";
  $("modalTitle").textContent=d.title || "Sans titre";
  $("modalDescription").textContent=d.description || d.commentaires || "";
  $("modalNature").textContent=d.nature || "Non renseigné";
  $("modalFormat").textContent=d.format || "Non renseigné";
  const modalExport = $("modalExport");
  if(modalExport) modalExport.textContent=(d.exportModes||[]).join(" / ") || "Non renseigné";
  $("modalSource").textContent=d.publisher || "Non renseigné";
  $("modalGeo").textContent=toArray(d.geo).join(", ") || "Non renseigné";
  $("modalGeometry").textContent=d.geometry || d.geolocalisation || "Non renseigné";
  $("modalPeriode").textContent=d.periode || formatPeriod(d) || "Non renseigné";
  $("modalDateDebut").textContent=d.dateDebut || "Non renseigné";
  $("modalDateFin").textContent=d.dateFin || "Non renseigné";
  $("modalModified").textContent=d.derniereMaj || d.lastModified || "Non renseigné";
  $("modalFrequence").textContent=d.frequence || "Non renseigné";
  $("modalGranularite").textContent=d.granularite || "Non renseigné";
  $("modalTempsReel").textContent=d.tempsReel || "Non renseigné";
  renderLiveDatasetAttributes(d);
  setUrlField(d.url, d.urlLabel || d.url_label || d.urlText);
  const modalVisualizeBtn = $("modalVisualizeBtn");
  if(modalVisualizeBtn){
    const spatialAction = getSpatialAction(d);
    if(spatialAction){
      modalVisualizeBtn.classList.remove("hidden", "visualize-btn", "spatial-diagnostic-btn");
      modalVisualizeBtn.classList.add(spatialAction.className);
      modalVisualizeBtn.textContent = spatialAction.label;
      modalVisualizeBtn.onclick = () => spatialAction.type === "map" ? visualizeDataset(d) : openSpatialDiagnostic(d);
    }else{
      modalVisualizeBtn.classList.add("hidden");
      modalVisualizeBtn.onclick = null;
    }
  }
  $("modalUse").textContent=d.use || "";
  $("modalTags").textContent=(d.tags||[]).join(", ");
  $("modal").classList.remove("hidden");
}
/** Rôle : Réinitialise l'ensemble des critères de recherche et de filtrage. */
function reset(){
  selectedKeywords=[]; clearCloudKeywordsStorage(); keywordSortValue="az"; tagSortValue="az"; timeFilterActive=false;
  [searchInput,keywordSearch,tagSearch].forEach(x=>x.value=""); datasetSort.value="modified";
  document.querySelectorAll('input[type="checkbox"]').forEach(x=>x.checked=false);
  $("keywordSortBtn").innerHTML = `Tri : A-Z <span>▾</span>`; $("tagSortBtn").innerHTML = `A-Z <span>▾</span>`;
  renderKeywords(); renderTags(); renderTime(); filterDatasets();
}
/** Rôle : Initialise les événements et composants interactifs de l'interface du catalogue. */
function setupUI(){
  document.querySelectorAll('.accordion').forEach(btn=>btn.addEventListener('click',()=>{
    const content = btn.nextElementSibling; const isHidden = content.classList.toggle('hidden');
    btn.querySelector('span').textContent = isHidden ? '⌄' : '⌃';
  }));
  $("keywordToggle").onclick=()=>{
    const hidden = $("keywordDrawer").classList.toggle("hidden");
    $("keywordToggle").innerHTML = hidden ? 'Afficher les mots-clés <span>▾</span>' : 'Masquer les mots-clés <span>▴</span>';
  };
  $("keywordSortBtn").onclick=()=>$("keywordSortMenu").classList.toggle("hidden");
  $("tagSortBtn").onclick=()=>$("tagSortMenu").classList.toggle("hidden");
  document.querySelectorAll('[data-keysort]').forEach(b=>b.onclick=()=>{keywordSortValue=b.dataset.keysort; $("keywordSortBtn").innerHTML=`Tri : ${sortLabel(keywordSortValue)} <span>▾</span>`; $("keywordSortMenu").classList.add('hidden'); renderKeywords();});
  document.querySelectorAll('[data-tagsort]').forEach(b=>b.onclick=()=>{tagSortValue=b.dataset.tagsort; $("tagSortBtn").innerHTML=`${sortLabel(tagSortValue)} <span>▾</span>`; $("tagSortMenu").classList.add('hidden'); renderTags();});
  document.addEventListener('click',e=>{
    if(!e.target.closest('.select-menu')) document.querySelectorAll('.select-popover').forEach(m=>m.classList.add('hidden'));
  });
  const moreToggle = $("modalMoreToggle");
  if(moreToggle){
    moreToggle.onclick = () => {
      const extra = $("modalExtraDetails");
      const hidden = extra.classList.toggle("hidden");
      moreToggle.setAttribute("aria-expanded", hidden ? "false" : "true");
      moreToggle.querySelector("span").textContent = hidden ? "Afficher tous les détails de la fiche" : "Masquer les détails de la fiche";
      moreToggle.querySelector("strong").textContent = hidden ? "▾" : "▴";
    };
  }
}
[searchInput,datasetSort].forEach(el=>el.addEventListener("input",filterDatasets));
[keywordSearch].forEach(el=>el.addEventListener("input",renderKeywords));
[tagSearch].forEach(el=>el.addEventListener("input",renderTags));
$("resetBtn").onclick=reset; $("clearKeywordBtn").onclick=()=>{selectedKeywords=[];clearCloudKeywordsStorage();updateKeywordSearchFromSelection();renderKeywords();filterDatasets();}; $("closeModal").onclick=()=>$("modal").classList.add("hidden"); $("modal").onclick=e=>{if(e.target.id==="modal")$("modal").classList.add("hidden")};

/** Rôle : Uniformise les métadonnées brutes d'un jeu avant leur utilisation dans l'interface. */
function normalizeDataset(d){
  const territory = toArray(d.geo || d.territoire || d.territory).filter(v => !/^geo(point|shape|json|metrie|métrie)$/i.test(String(v).trim()));
  const publisher = normalizePublisherValue(d.publisher || d.source || "Non renseigné");
  const formats = inferAutoFormatsClient(d);
  const exportModes = detectExportModes({...d, publisher}, formats);
  const obj = {
    title: d.title || d.nom || d.name || "Sans titre",
    theme: d.theme || "Non classé",
    nature: d.nature || "Statique",
    format: formats.length ? formats.join(" / ") : (d.format || "Non renseigné"),
    formats: formats,
    exportModes: exportModes,
    publisher: publisher,
    geo: territory.length ? territory : ["Non renseigné"],
    geometry: d.geometry || d.geometrie || d.geolocalisation || d.geoLocalisation || "",
    dateDebut: d.dateDebut || d.date_debut || d.startDate || "",
    dateFin: d.dateFin || d.date_fin || d.endDate || "",
    derniereMaj: d.derniereMaj || d.derniere_maj || d.lastModified || d.last_modified || "",
    lastModified: d.lastModified || d.last_modified || d.derniereMaj || d.derniere_maj || "Non renseigné",
    tempsReel: d.tempsReel || d.temps_reel || "",
    tags: normalizeTags(d.tags),
    description: d.description || d.commentaires || d.commentaire || d.url || "",
    commentaires: d.commentaires || d.commentaire || "",
    use: d.use || d.usage || "",
    url: d.url || "",
    urlLabel: d.urlLabel || d.url_label || d.urlText || d.url_label_display || "",
    periode: d.periode || "",
    frequence: d.frequence || "",
    granularite: d.granularite || d.granulariteTemporelle || "",
    attributs: d.attributs || {}
  };
  obj.cloudTerms = extractCloudTermsFromDataset(obj);
  return obj;
}

/** Rôle : Contrôle et complète les formats détectés pour les jeux chargés. */
function auditFormats(){
  const rows = datasets.map(d => ({
    title: d.title,
    publisher: d.publisher,
    url: d.url,
    format: d.format,
    formats: (d.formats || []).join(', '),
    formatsAuto: Array.isArray(d.formatsAuto) ? d.formatsAuto.join(', ') : ''
  }));
  console.table(rows);
  const noFormat = rows.filter(r => !r.formats);
  console.log('Datasets sans format détecté :', noFormat.length);
  if(noFormat.length) console.table(noFormat);
}
window.auditFormats = auditFormats;

/** Rôle : Charge les métadonnées du catalogue depuis la source configurée. */
async function loadDatasets(){
  datasets = datasets.map(normalizeDataset);
  if(!APPS_SCRIPT_URL){
    console.info(`Mode local : ${datasets.length} datasets chargés depuis sample-data.js. Ajoute ton URL Apps Script dans APPS_SCRIPT_URL pour lire le Google Sheet en direct.`);
    return;
  }
  try{
    const response = await fetch(APPS_SCRIPT_URL + `?sheetId=${encodeURIComponent(GOOGLE_SHEET_ID)}&t=${Date.now()}`);
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    datasets = (Array.isArray(data) ? data : data.datasets || []).map(normalizeDataset);
    console.info(`${datasets.length} datasets chargés depuis Google Sheet.`);
  }catch(error){
    console.error("Impossible de charger Google Sheet. Données locales utilisées.", error);
  }
}
/** Rôle : Masque l'indicateur de chargement du catalogue. */
function hideCatalogueLoading(){
  const loading = document.getElementById("catalogueLoading");
  if(loading) loading.classList.add("is-hidden");
}

/** Rôle : Initialise le catalogue, charge les données et déclenche le premier affichage. */
async function init(){
  setupUI();
  try{
    await loadDatasets();
    loadCloudKeywordsFromStorage();
    updateKeywordSearchFromSelection();
    populate();
    filterDatasets();
  }finally{
    hideCatalogueLoading();
  }
}
init();


const clearMapSelectionBtn = $("clearMapSelectionBtn");
if(clearMapSelectionBtn) clearMapSelectionBtn.addEventListener("click", () => { selectedMapDatasets.clear(); document.querySelectorAll("[data-map-select-id]").forEach(input => input.checked = false); updateMapSelectionBar(); });
const confirmMapSelectionBtn = $("confirmMapSelectionBtn");
if(confirmMapSelectionBtn) confirmMapSelectionBtn.addEventListener("click", openSelectedDatasetsMap);
