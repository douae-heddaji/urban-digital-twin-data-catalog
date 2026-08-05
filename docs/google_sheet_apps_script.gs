/**
 * Apps Script à coller dans : Google Sheet > Extensions > Apps Script.
 * Puis : Déployer > Nouveau déploiement > Application Web > Exécuter en tant que Moi > Accès : Tout le monde.
 * Copie ensuite l’URL /exec dans APPS_SCRIPT_URL du fichier script.js.
 *
 * Version corrigée :
 * - lit Date début, Date fin, Dernière MAJ pour le filtre temporel ;
 * - sépare Territoire (Toulouse/Blagnac) et Géolocalisation/Géométrie (GeoPoint, GeoShape...) ;
 * - renvoie les colonnes de fiche : fréquence, granularité temporelle, URL, attributs, commentaires.
 */
const DEFAULT_SPREADSHEET_ID = "1hlZBcHTi2NvcqdmKnrUqhuyJnW_ls0TUOxNPkHEl6dc";

/** Rôle : Assure le traitement associé à « do get ». */
function doGet(e) {
  const sheetId = (e && e.parameter && e.parameter.sheetId) || DEFAULT_SPREADSHEET_ID;
  const ss = SpreadsheetApp.openById(sheetId);
  const datasets = [];

  ss.getSheets().forEach(sheet => {
    const theme = sheet.getName();
    if (normalizeHeader(theme).startsWith("presentation") || normalizeHeader(theme).startsWith("guide")) return;

    const range = sheet.getDataRange();
    const values = range.getValues();
    const displayValues = range.getDisplayValues();
    if (values.length < 2) return;

    const headers = displayValues[0].map(v => String(v || "").trim());
    const subHeaders = displayValues[1].map(v => String(v || "").trim());
    // Certaines colonnes importantes comme URL / Tags / sous-catégories d’attributs
    // sont parfois en ligne 2 à cause des cellules fusionnées.
    // On construit donc une carte d’en-têtes avec la ligne 1 ET la ligne 2.
    const headerMap = buildHeaderMap(headers, subHeaders);
    const richTexts = range.getRichTextValues();

    for (let i = 2; i < values.length; i++) {
      const row = values[i];
      const rowDisplay = displayValues[i].map(v => String(v || "").trim());
      const title = getByHeader(rowDisplay, headerMap, ["type de transport", "type d'environnement", "type"]);
      if (!title) continue;

      const publisher = getByHeader(rowDisplay, headerMap, ["source des données"]);
      const format = getByHeader(rowDisplay, headerMap, ["format", "fomat"]);
      const urlInfo = getUrlByHeader(rowDisplay, richTexts[i], headerMap, ["url"]);
      const url = urlInfo.url;
      const dateDebut = dateToIso(getByHeader(row, headerMap, ["date début", "date debut"]));
      const dateFin = dateToIso(getByHeader(row, headerMap, ["date fin"]));
      const derniereMaj = dateToIso(getByHeader(row, headerMap, ["dernière maj", "derniere maj"]));
      const tags = extractTags(rowDisplay, headers);

      // Ignore les lignes de section : elles n'ont ni source, ni format, ni URL, ni date, ni tag.
      if (!(publisher || format || url || dateDebut || dateFin || derniereMaj || tags.length)) continue;

      const tempsReel = getByHeader(rowDisplay, headerMap, ["données en temps réel", "donnée en temps réel", "données en temsp réel"]);
      const geometry = getByHeader(rowDisplay, headerMap, ["géolocalisation", "geolocalisation"]);
      const commentaires = getByHeader(rowDisplay, headerMap, ["commentaires"]);

      // Formats automatiques : on ne dépend plus uniquement de la colonne Format.
      // data.gouv : lecture des ressources via l'API.
      // OpenDataSoft : lecture/test des exports + fallback plateforme.
      const formatsAuto = getOpenDataFormats(url, publisher, geometry, urlInfo.label || title);
      const finalFormat = formatsAuto.length ? formatsAuto.join(" / ") : (format || "Non renseigné");

      datasets.push({
        title: title,
        theme: theme,
        nature: inferNature(rowDisplay, tempsReel),
        format: finalFormat,
        formatsAuto: formatsAuto,
        publisher: publisher || "Non renseigné",
        geo: inferTerritory(rowDisplay),
        geometry: geometry,
        dateDebut: dateDebut,
        dateFin: dateFin,
        derniereMaj: derniereMaj,
        lastModified: derniereMaj || dateFin || dateDebut || "Non renseigné",
        tempsReel: tempsReel,
        tags: unique(tags.length ? tags : ["non_classé"]),
        description: commentaires || url || `Jeu de données de la thématique ${theme}.`,
        commentaires: commentaires,
        use: `Alimenter la couche ${theme.toLowerCase()} du jumeau numérique urbain.`,
        url: url,
        urlLabel: urlInfo.label,
        periode: getByHeader(rowDisplay, headerMap, ["période couverte", "periode couverte"]),
        frequence: getByHeader(rowDisplay, headerMap, ["fréquence", "frequence"]),
        granularite: getByHeader(rowDisplay, headerMap, ["granularité temporelle", "granularite temporelle"]),
        attributs: extractAttributes(rowDisplay, headers, subHeaders)
      });
    }
  });

  return ContentService
    .createTextOutput(JSON.stringify({ datasets }))
    .setMimeType(ContentService.MimeType.JSON);
}


/** Rôle : Récupère open data formats. */
function getOpenDataFormats(datasetUrl, publisher, geometry, labelOrTitle) {
  const formats = [];
  const add = f => { if (f && !formats.includes(f)) formats.push(f); };
  const url = String(datasetUrl || "").trim();
  const label = String(labelOrTitle || "").trim();
  const pub = normalizeHeader(publisher);
  const text = normalizeHeader([url, label, publisher].join(" "));

  // 1) data.gouv.fr : lecture des ressources via l'API officielle.
  // On lit les noms/URLs des fichiers, pas seulement le champ format.
  if (/data\.gouv\.fr/i.test(url)) {
    getDataGouvFormats(url).forEach(add);
  }

  // 2) OpenDataSoft : lecture de l'onglet export/API quand l'URL réelle est disponible.
  if (isOpenDataSoftUrl(url)) {
    getOpenDataSoftFormats(url, geometry).forEach(add);
  }

  // 3) Page HTML générique : utile pour data.gouv ou d'autres catalogues si l'API dédiée échoue.
  if (!formats.length && /^https?:\/\//i.test(url)) {
    getFormatsFromHtmlPage(url).forEach(add);
  }

  // 4) Fallback plateforme OpenDataSoft : version générale par plateforme.
  // Tous les portails ODS affichent généralement CSV, JSON, Excel/XLSX et Parquet.
  // Si la donnée est géographique, on ajoute les exports géographiques courants.
  if (isOpenDataSoftUrl(url) || /open data toulouse|toulouse metropole|opendatasoft/i.test(text)) {
    ["CSV", "JSON", "XLSX", "PARQUET"].forEach(add);
    if (hasGeometryText(geometry + " " + label)) ["GEOJSON", "SHP", "KML"].forEach(add);
  }

  // 5) Secours final : extension visible dans l'URL ou dans le libellé.
  detectFormatsInText(url + " " + label).forEach(add);

  return formats;
}

/** Rôle : Récupère data gouv formats. */
function getDataGouvFormats(datasetUrl) {
  const slug = extractDataGouvSlug(datasetUrl);
  if (!slug) return [];

  const cacheKey = "formats_v5_datagouv_" + slug;
  const cached = getCachedFormats(cacheKey);
  if (cached) return cached;

  const formats = [];
  const add = f => { if (f && !formats.includes(f)) formats.push(f); };

  try {
    const apiUrl = "https://www.data.gouv.fr/api/1/datasets/" + encodeURIComponent(slug) + "/";
    const response = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true, followRedirects: true });
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      const data = JSON.parse(response.getContentText());
      const resources = data.resources || [];
      resources.forEach(r => {
        // Important : on lit aussi title/url/latest/url, pas seulement r.format.
        // Exemple : aires-de-jeux.geojson peut avoir format=json dans data.gouv.
        detectFormatsInText([
          r.format,
          r.title,
          r.url,
          r.latest,
          r.description,
          r.mime
        ].join(" ")).forEach(add);
      });
    }
  } catch (e) {}

  setCachedFormats(cacheKey, formats);
  return formats;
}

/** Rôle : Extrait data gouv slug. */
function extractDataGouvSlug(url) {
  const raw = String(url || "").trim();
  let m = raw.match(/data\.gouv\.fr\/(?:fr\/)?datasets\/([^/?#]+)/i);
  return m ? m[1] : "";
}

/** Rôle : Vérifie si open data soft url. */
function isOpenDataSoftUrl(url) {
  const raw = String(url || "").trim();
  return /\/explore\/dataset\//i.test(raw) || /\/api\/explore\//i.test(raw) || /opendatasoft/i.test(raw) || /data\.toulouse-metropole\.fr/i.test(raw);
}

/** Rôle : Récupère open data soft formats. */
function getOpenDataSoftFormats(datasetUrl, geometry) {
  const datasetId = extractOpenDataDatasetId(datasetUrl);
  const base = extractOpenDataSoftBaseUrl(datasetUrl);
  if (!datasetId || !base) return [];

  const cacheKey = "formats_v5_ods_" + base.replace(/[^a-z0-9]/gi, "_") + "_" + datasetId;
  const cached = getCachedFormats(cacheKey);
  if (cached) return cached;

  const formats = [];
  const add = f => { if (f && !formats.includes(f)) formats.push(f); };

  const urlsToTry = [
    base + "/explore/dataset/" + datasetId + "/export/",
    base + "/api/explore/v2.1/catalog/datasets/" + datasetId,
    base + "/api/explore/v2.1/catalog/datasets/" + datasetId + "/exports"
  ];

  urlsToTry.forEach(fetchUrl => {
    try {
      const response = UrlFetchApp.fetch(fetchUrl, { muteHttpExceptions: true, followRedirects: true });
      if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
        detectFormatsInText(response.getContentText()).forEach(add);
      }
    } catch (e) {}
  });

  // Si la page/API ne liste pas correctement mais que l'export standard ODS existe,
  // on teste quelques endpoints. HEAD n'est pas toujours accepté, donc GET avec mute.
  if (!formats.length) {
    ["csv", "json", "geojson", "xlsx", "parquet", "kml", "shp", "gpkg"].forEach(fmt => {
      try {
        const testUrl = base + "/api/explore/v2.1/catalog/datasets/" + datasetId + "/exports/" + fmt;
        const res = UrlFetchApp.fetch(testUrl, { muteHttpExceptions: true, followRedirects: true });
        if (res.getResponseCode() >= 200 && res.getResponseCode() < 400) {
          detectFormatsInText("file." + fmt).forEach(add);
        }
      } catch (e) {}
    });
  }

  // Si un format géographique est explicitement visible dans la géométrie, on ne l'invente pas seul,
  // mais on aide la détection quand l'export page contient des mentions génériques.
  detectFormatsInText(String(geometry || "")).forEach(add);

  setCachedFormats(cacheKey, formats);
  return formats;
}

/** Rôle : Extrait open data soft base url. */
function extractOpenDataSoftBaseUrl(url) {
  const raw = String(url || "").trim();
  const m = raw.match(/^(https?:\/\/[^/]+)/i);
  return m ? m[1] : "";
}

/** Rôle : Extrait open data dataset id. */
function extractOpenDataDatasetId(url) {
  const raw = String(url || "").trim();

  let match = raw.match(/\/explore\/dataset\/([^/?#]+)/i);
  if (match) return match[1];

  match = raw.match(/\/catalog\/datasets\/([^/?#]+)/i);
  if (match) return match[1];

  return "";
}

/** Rôle : Récupère formats from html page. */
function getFormatsFromHtmlPage(url) {
  const cacheKey = "formats_v5_page_" + Utilities.base64EncodeWebSafe(url).slice(0, 80);
  const cached = getCachedFormats(cacheKey);
  if (cached) return cached;

  const formats = [];
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      detectFormatsInText(response.getContentText()).forEach(f => {
        if (!formats.includes(f)) formats.push(f);
      });
    }
  } catch (e) {}

  setCachedFormats(cacheKey, formats);
  return formats;
}

/** Rôle : Détecte formats in text. */
function detectFormatsInText(text) {
  const original = String(text || "");
  const raw = normalizeHeader(original);
  const formats = [];
  const add = f => { if (f && !formats.includes(f)) formats.push(f); };

  // 1) Extensions de fichiers : priorité maximale.
  // Exemple : aires-de-jeux.geojson => GEOJSON même si un site indique "format json".
  const extRegex = /\.([a-z0-9]+)(?=($|[?#\s)"'<>]))/gi;
  let match;
  while ((match = extRegex.exec(original)) !== null) {
    const ext = String(match[1] || "").toLowerCase();
    formatFromToken(ext).forEach(add);
  }

  // 2) Libellés textuels.
  ["geojson", "csv", "json", "gpkg", "geopackage", "xlsx", "xls", "excel", "parquet", "geoparquet", "zip", "shp", "shapefile", "kml", "xml"].forEach(token => {
    if (new RegExp("(^|[^a-z0-9])" + token + "([^a-z0-9]|$)").test(raw)) {
      formatFromToken(token).forEach(add);
    }
  });

  return formats;
}

/** Rôle : Formate from token. */
function formatFromToken(token) {
  token = String(token || "").toLowerCase();
  if (token === "csv") return ["CSV"];
  if (token === "json") return ["JSON"];
  if (token === "geojson") return ["GEOJSON"];
  if (token === "gpkg" || token === "geopackage") return ["GPKG"];
  if (token === "xlsx" || token === "xls" || token === "excel") return ["XLSX"];
  if (token === "parquet" || token === "geoparquet") return ["PARQUET"];
  if (token === "zip") return ["ZIP"];
  if (token === "shp" || token === "shapefile") return ["SHP"];
  if (token === "kml") return ["KML"];
  if (token === "xml") return ["XML"];
  return [];
}

/** Rôle : Récupère cached formats. */
function getCachedFormats(key) {
  try {
    const value = CacheService.getScriptCache().get(key);
    return value ? JSON.parse(value) : null;
  } catch (e) {
    return null;
  }
}

/** Rôle : Assure le traitement associé à « set cached formats ». */
function setCachedFormats(key, formats) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(formats || []), 21600);
  } catch (e) {}
}

/** Rôle : Vérifie la présence de geometry text. */
function hasGeometryText(text) {
  const raw = normalizeHeader(text);
  return /geopoint|geoshape|geojson|geometry|geometrie|geom|point|ligne|line|polygone|polygon|multipolygon|lat|lon|latitude|longitude/.test(raw);
}

/** Rôle : Normalise header. */
function normalizeHeader(h) {
  return String(h || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rôle : Construit header map. */
function buildHeaderMap(headers, subHeaders) {
  const map = {};
  [headers || [], subHeaders || []].forEach(row => {
    row.forEach((h, i) => {
      const key = normalizeHeader(h);
      if (key) map[key] = i;
    });
  });
  return map;
}

/** Rôle : Récupère by header. */
function getByHeader(row, map, names) {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (map[key] !== undefined) return row[map[key]];
  }
  return "";
}


/** Rôle : Récupère url by header. */
function getUrlByHeader(rowDisplay, richRow, map, names) {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (map[key] !== undefined) {
      const col = map[key];
      const label = String(rowDisplay[col] || "").trim();
      const rich = richRow && richRow[col];
      let link = "";

      // Cas 1 : la cellule entière est un lien.
      if (rich && rich.getLinkUrl && rich.getLinkUrl()) {
        link = rich.getLinkUrl();
      }

      // Cas 2 : seulement une partie du texte est un lien.
      if (!link && rich && rich.getRuns) {
        const runs = rich.getRuns();
        for (const run of runs) {
          if (run.getLinkUrl && run.getLinkUrl()) {
            link = run.getLinkUrl();
            break;
          }
        }
      }

      // Cas 3 : la cellule contient déjà une URL écrite en clair.
      if (!link && /^https?:\/\//i.test(label)) link = label;

      return {
        label: label,
        url: link || label
      };
    }
  }
  return { label: "", url: "" };
}

/** Rôle : Convertit une date valide au format ISO utilisé pour les comparaisons. */
function dateToIso(value) {
  if (!value) return "";
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  const raw = String(value).trim();
  if (!raw) return "";
  const up = raw.toUpperCase().replace("É", "E");
  if (["PRESENT", "PRESENTE"].includes(up)) return "PRESENT";
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  const fr = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (fr) return `${fr[3]}-${String(fr[2]).padStart(2, "0")}-${String(fr[1]).padStart(2, "0")}`;
  return raw;
}

/** Rôle : Extrait tags. */
function extractTags(row, headers) {
  const tags = [];
  headers.forEach((h, i) => {
    if (normalizeHeader(h).startsWith("tag")) splitValues(row[i]).forEach(v => tags.push(v));
  });
  return unique(tags);
}

/** Rôle : Extrait attributes. */
function extractAttributes(row, headers, subHeaders) {
  const attrs = {};
  headers.forEach((h, i) => {
    const hNorm = normalizeHeader(h);
    const sub = String(subHeaders[i] || "").trim();
    const subNorm = normalizeHeader(sub);
    if (hNorm === "attributs" || subNorm.startsWith("att")) {
      const value = String(row[i] || "").trim();
      if (value) attrs[sub || h || `Attribut ${i + 1}`] = value;
    }
  });
  return attrs;
}

/** Rôle : Assure le traitement associé à « split values ». */
function splitValues(value) {
  return String(value || "")
    .split(/[;,\n]/)
    .map(v => v.trim())
    .filter(v => v && v.length < 80 && !v.toLowerCase().startsWith("http") && !/^non renseign/i.test(v));
}

/** Rôle : Assure le traitement associé à « unique ». */
function unique(arr) {
  const seen = {};
  return arr.filter(v => {
    const key = String(v).toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

/** Rôle : Assure le traitement associé à « infer territory ». */
function inferTerritory(row) {
  const text = row.join(" ").toLowerCase();
  const geo = [];
  if (text.includes("toulouse") || text.includes("métropole") || text.includes("metropole")) geo.push("Toulouse");
  if (text.includes("blagnac")) geo.push("Blagnac");
  return geo.length ? geo : ["Non renseigné"];
}

/** Rôle : Assure le traitement associé à « infer nature ». */
function inferNature(row, tempsReel) {
  // La nature dépend uniquement de la colonne « Données en temps réel ».
  // Une API, une fréquence horaire/annuelle ou une date de MAJ ne signifie pas
  // automatiquement que le contenu du dataset est dynamique.
  const value = String(tempsReel || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /^oui(?:\b|\s|[,;:()\-])/.test(value) ? "Dynamique" : "Statique";
}
