const params = new URLSearchParams(location.search);
const ids = (params.get("datasets") || params.get("dataset") || "").split(",").map(v => v.trim()).filter(Boolean);
const rawTitles = (params.get("titles") || params.get("title") || "").split("||");
const datasets = ids.map((id, i) => ({ id, title: rawTitles[i] || id }));
const referenceSource = params.get("reference_source") || ""; // ancien format, conservé pour compatibilité
const referenceTarget = params.get("reference_target") || "";
const referenceTitle = params.get("reference_title") || "";
const referenceSourceTitle = params.get("source_title") || "";
const referenceSourceField = params.get("source_field") || "";
const referenceTargetField = params.get("target_field") || "";
// Croisement multi-datasets : chaque dataset sélectionné peut avoir son propre
// référentiel de jointure (résolu automatiquement au moment de la sélection
// dans le catalogue). Ces paramètres sont des listes parallèles à `datasets`,
// séparées par "||", avec une entrée vide pour un dataset sans jointure.
/** Rôle : Découpe un paramètre d'URL en conservant son alignement avec les jeux sélectionnés. */
function splitAlignedParam(raw, count) {
  const parts = raw ? raw.split("||") : [];
  return Array.from({ length: count }, (_, i) => parts[i] || "");
}
const perDatasetReferenceTargets = splitAlignedParam(params.get("reference_targets"), datasets.length);
const perDatasetReferenceTitles = splitAlignedParam(params.get("reference_titles"), datasets.length);
const perDatasetSourceFields = splitAlignedParam(params.get("source_fields"), datasets.length);
const perDatasetTargetFields = splitAlignedParam(params.get("target_fields"), datasets.length);
const datasetJoinInfo = new Map();
datasets.forEach((dataset, i) => {
  const target = perDatasetReferenceTargets[i];
  const sourceField = perDatasetSourceFields[i];
  const targetField = perDatasetTargetFields[i];
  if (target && sourceField && targetField) {
    datasetJoinInfo.set(dataset.id, {
      referenceTarget: target,
      referenceTitle: perDatasetReferenceTitles[i] || target,
      sourceField,
      targetField
    });
  }
});
const temporalId = "comptages-routiers-et-pietons-2025";
const palette = ["#2563eb", "#16a34a", "#dc2626", "#7c3aed", "#ea580c", "#0891b2", "#be123c", "#4d7c0f"];

const map = L.map("map").setView([43.6047, 1.4442], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

const state = new Map();
let activeBounds = null;
let activeZoneGeometry = null; // vraie forme (polygone) de la zone, quand disponible
let zoneLayer = null;
let searchResults = [];
let analysisLayers = [];
let analysisActive = false;
let lastAnalysis = null;

const $ = id => document.getElementById(id);
const statusEl = $("status");
const statusCard = document.querySelector(".status-card");
const dateInput = $("dateInput");
const hourInput = $("hourInput");
const metricInput = $("metricInput");
const reloadBtn = $("reloadBtn");
const latestCommonBtn = $("latestCommonBtn");
const viewModeInput = $("viewModeInput");
const analysisControls = $("analysisControls");
const analysisDatasetA = $("analysisDatasetA");
const analysisDatasetB = $("analysisDatasetB");
const analysisDistance = $("analysisDistance");
const runAnalysisBtn = $("runAnalysisBtn");
const runMultiAnalysisBtn = $("runMultiAnalysisBtn");
const restoreAllBtn = $("restoreAllBtn");
const analysisResult = $("analysisResult");
const mapLoading = $("mapLoading");
const mapLoadingTitle = $("mapLoadingTitle");
const mapLoadingMessage = $("mapLoadingMessage");
const mapLoadingDetail = $("mapLoadingDetail");

const temporalControls = $("temporalControls");
const temporalFeedback = $("temporalFeedback");
const metricLine = $("metricLine");
const periodControls = $("periodControls");
const periodModeAll = $("periodModeAll");
const periodModeRange = $("periodModeRange");
const periodRangeInputs = $("periodRangeInputs");
const periodStartInput = $("periodStartInput");
const periodEndInput = $("periodEndInput");
const periodReloadBtn = $("periodReloadBtn");
const periodFeedback = $("periodFeedback");
// Certains navigateurs restaurent une valeur précédemment saisie dans un champ
// au rechargement de la page, même sans notre JS — on force donc les champs
// vides dès le départ pour garantir qu'aucune date obsolète ne persiste.
if (dateInput) dateInput.value = "";
if (hourInput) hourInput.value = "";
let temporalDatasetIds = new Set();
let temporalSchemas = new Map();
let temporalRanges = new Map();
let periodDatasetIds = new Set();
let periodRanges = new Map();
let datasetExportFormats = new Map();

/** Rôle : Interprète une valeur exemple afin d'identifier son format temporel. */
function parseTemporalSample(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Rôle : Récupère les plages disponibles et configure les contrôles temporels de la carte. */
async function initializeTemporalControls() {
  const checks = await Promise.allSettled(datasets.map(async dataset => {
    const [schemaResponse, rangeResponse, periodResponse, formatResponse] = await Promise.all([
      fetch(`/api/dataset-schema/${encodeURIComponent(dataset.id)}`),
      fetch(`/api/dataset-temporal-range/${encodeURIComponent(dataset.id)}`),
      fetch(`/api/dataset-period-range/${encodeURIComponent(dataset.id)}`),
      fetch(`/api/dataset-export-format/${encodeURIComponent(dataset.id)}`)
    ]);
    const schema = schemaResponse.ok ? await schemaResponse.json() : null;
    const range = rangeResponse.ok ? await rangeResponse.json() : null;
    const period = periodResponse.ok ? await periodResponse.json() : null;
    const formatInfo = formatResponse.ok ? await formatResponse.json() : null;
    datasetExportFormats.set(dataset.id, formatInfo?.export_format || "geojson");
    const hasPeriod = period?.period_available && period.min_date && period.max_date;
    if (hasPeriod) {
      periodDatasetIds.add(dataset.id);
      periodRanges.set(dataset.id, period);
    }
    // Un dataset "période" (date_debut/date_fin) décrit des intervalles, un
    // dataset "temporel" décrit des instants ponctuels — mais dans les deux
    // cas, on utilise maintenant le MÊME panneau Date/Heure unique : c'est le
    // serveur qui choisit la bonne interprétation (inclusion dans la période,
    // ou instant exact/le plus proche) selon la structure réelle du dataset.
    const hasTemporal = range?.temporal_available && range.min_date && range.max_date;
    const effectiveRange = hasPeriod
      ? {
          dataset: dataset.id,
          temporal_available: true,
          min_date: period.min_date,
          max_date: period.max_date,
          min_datetime: `${period.min_date}T00:00`,
          max_datetime: `${period.max_date}T23:59`,
          is_period: true,
        }
      : (hasTemporal ? range : null);
    if (!effectiveRange) return null;
    temporalDatasetIds.add(dataset.id);
    if (schema) temporalSchemas.set(dataset.id, schema);
    temporalRanges.set(dataset.id, effectiveRange);
    return effectiveRange;
  }));

  if (temporalDatasetIds.size) {
    temporalControls.classList.remove("hidden");
    updateTemporalCalendarRange();
  } else {
    temporalControls.classList.add("hidden");
  }
  // Le panneau "Période de validité" séparé n'est plus utilisé : le panneau
  // Date/Heure unique couvre maintenant aussi ce cas.
  if (periodControls) periodControls.classList.add("hidden");
  if (metricLine) metricLine.classList.toggle("hidden", !datasets.some(dataset => dataset.id === temporalId));
}

/** Rôle : Affiche un retour utilisateur sur la période actuellement sélectionnée. */
function updatePeriodFeedback() {
  if (!periodFeedback) return;
  const ranges = [...periodDatasetIds].map(id => periodRanges.get(id)).filter(Boolean);
  if (ranges.length) {
    const overallMin = ranges.map(r => r.min_date).sort().at(0);
    const overallMax = ranges.map(r => r.max_date).sort().at(-1);
    if (periodStartInput) { periodStartInput.min = overallMin; periodStartInput.max = overallMax; }
    if (periodEndInput) { periodEndInput.min = overallMin; periodEndInput.max = overallMax; }
  }
  const details = [...periodDatasetIds].map(id => {
    const range = periodRanges.get(id);
    const dataset = datasets.find(item => item.id === id);
    return `${dataset?.title || id} : ${range.min_date} → ${range.max_date}`;
  }).join(" | ");
  periodFeedback.textContent = `Période(s) de validité disponible(s) : ${details}`;
}

/** Rôle : Calcule la fenêtre temporelle commune aux jeux affichés. */
function computeActiveTemporalWindow() {
  const activeRanges = datasets
    .filter(dataset => temporalRanges.has(dataset.id) && state.get(dataset.id)?.enabled !== false)
    .map(dataset => temporalRanges.get(dataset.id));
  if (!activeRanges.length) return null;
  // For a crossing, only dates available in every active temporal dataset are valid.
  const commonMin = activeRanges.map(range => range.min_date).sort().at(-1);
  const commonMax = activeRanges.map(range => range.max_date).sort().at(0);
  const hasCommonRange = commonMin <= commonMax;
  // The time-of-day to prefill must come from a dataset whose own last day IS
  // the common bottleneck date (commonMax) — borrowing the clock time from a
  // dataset whose last day is later would produce a time that has nothing to
  // do with commonMax and likely doesn't exist in either dataset that day.
  const boundingRanges = activeRanges.filter(range => range.max_date === commonMax);
  const latestRange = (boundingRanges.length ? boundingRanges : activeRanges)
    .reduce((best, range) => range.max_datetime > best.max_datetime ? range : best, (boundingRanges.length ? boundingRanges : activeRanges)[0]);
  return { activeRanges, commonMin, commonMax, hasCommonRange, latestRange };
}

/** Rôle : Met à jour les bornes autorisées dans les champs de calendrier. */
function updateTemporalCalendarRange() {
  const window = computeActiveTemporalWindow();
  if (!window) {
    temporalControls.classList.add("hidden");
    return;
  }
  temporalControls.classList.remove("hidden");
  const { activeRanges, commonMin, commonMax, hasCommonRange, latestRange } = window;

  dateInput.min = commonMin;
  dateInput.max = commonMax;
  reloadBtn.disabled = !hasCommonRange;
  if (latestCommonBtn) {
    // Le bouton n'a de sens que pour trouver une période commune entre
    // PLUSIEURS datasets croisés ; avec un seul dataset actif, il n'y a rien
    // de "commun" à calculer — le cacher plutôt que d'afficher un bouton
    // trompeur qui ne fait alors que reprendre la propre plage du dataset.
    const isCrossing = activeRanges.length > 1;
    latestCommonBtn.classList.toggle("hidden", !isCrossing);
    latestCommonBtn.disabled = !hasCommonRange;
  }

  if (!hasCommonRange) {
    dateInput.value = "";
    temporalFeedback.textContent = "Les datasets temporels cochés n’ont aucune période commune. Décoche une couche ou choisis d’autres datasets.";
    return;
  }

  // On ne pré-remplit plus automatiquement la date avec commonMax : ça
  // forçait silencieusement un filtre temporel (parfois sur une date sans
  // aucune donnée réelle) même quand personne n'avait rien demandé, bloquant
  // l'affichage de base du dataset. Par défaut, le champ reste vide — ce qui
  // affiche les données sans filtre de date — et on ne corrige que si une
  // date déjà saisie est sortie de la plage valide.
  if (dateInput.value && (dateInput.value < commonMin || dateInput.value > commonMax)) {
    dateInput.value = commonMax;
  }
  if (dateInput.value) {
    const latest = parseTemporalSample(latestRange.max_datetime);
    if (!hourInput.value && latest) {
      hourInput.value = `${String(latest.getHours()).padStart(2, "0")}:${String(latest.getMinutes()).padStart(2, "0")}`;
    }
  }

  const details = activeRanges.map(range => {
    const dataset = datasets.find(item => item.id === range.dataset);
    const label = range.is_period ? " (période : la date choisie doit tomber dans l’intervalle)" : "";
    return `${dataset?.title || range.dataset} : ${range.min_date} → ${range.max_date}${label}`;
  }).join(" | ");
  temporalFeedback.textContent = activeRanges.length === 1
    ? `Période réelle disponible : ${commonMin} → ${commonMax}. ${details}`
    : `Période commune aux datasets temporels cochés : ${commonMin} → ${commonMax}. ${details}`;
}

/** Rôle : Sélectionne automatiquement la période commune la plus récente. */
function useLatestCommonPeriod() {
  const window = computeActiveTemporalWindow();
  if (!window || !window.hasCommonRange) return;
  dateInput.value = window.commonMax;
  const latest = parseTemporalSample(window.latestRange.max_datetime);
  if (latest) {
    hourInput.value = `${String(latest.getHours()).padStart(2, "0")}:${String(latest.getMinutes()).padStart(2, "0")}`;
  }
  updateTemporalCalendarRange();
  loadAll();
}

/** Rôle : Échappe une valeur avant son insertion dans du HTML. */
function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
/** Rôle : Formate une valeur de propriété pour son affichage dans l'interface. */
function fmt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("fr-FR").format(number) : "0";
}
/** Rôle : Met à jour le message d'état et l'action éventuelle affichés à l'utilisateur. */
function setStatus(message, type = "", actionLabel = null, actionFn = null) {
  statusEl.textContent = message;
  statusCard.classList.remove("ok", "error");
  if (type) statusCard.classList.add(type);
  const existingAction = statusCard.querySelector(".status-action");
  if (existingAction) existingAction.remove();
  if (actionLabel && actionFn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "status-action secondary-btn";
    btn.textContent = actionLabel;
    btn.addEventListener("click", actionFn);
    statusCard.appendChild(btn);
  }
}
const ALL_ATTRIBUTES = "__all__";
/** Rôle : Détecte si une chaîne semble contenir un objet ou tableau JSON sérialisé. */
function looksLikeSerializedJson(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}
/** Rôle : Recense les attributs disponibles dans les entités d'un jeu géographique. */
function availableAttributes(data) {
  const attributes = new Set();
  for (const feature of data?.features || []) {
    for (const [key, value] of Object.entries(feature.properties || {})) {
      if (key.startsWith("_") || key.toLowerCase().includes("geo")) continue;
      // Un objet/tableau imbriqué (ou un texte qui contient en fait du JSON
      // sérialisé, ex. le champ "data" de VélÔToulouse) ne s'affiche jamais
      // correctement dans le popup (voir formatAttributeValue) : inutile de
      // le proposer ici.
      if (value !== null && typeof value === "object") continue;
      if (looksLikeSerializedJson(value)) continue;
      attributes.add(key);
    }
  }
  return [...attributes].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
}
/** Rôle : Formate une valeur d'attribut pour la rendre lisible dans une infobulle. */
function formatAttributeValue(value) {
  if (value === null || value === undefined || value === "") return "Non renseigné";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
/** Rôle : Génère le contenu de l'infobulle d'une entité cartographique. */
function popup(feature, dataset, selectedAttribute = ALL_ATTRIBUTES) {
  const props = feature.properties || {};
  const keys = selectedAttribute === ALL_ATTRIBUTES
    ? Object.keys(props).filter(key => !key.startsWith("_") && !key.toLowerCase().includes("geo"))
    : [selectedAttribute];

  const groups = { source: [], reference: [], join: [], other: [] };
  const prefixes = {
    "Dataset analysé —": "source",
    "Référentiel géographique —": "reference",
    "Jointure —": "join"
  };
  for (const key of keys) {
    const rawValue = props[key];
    // Do not display empty placeholders: only values really returned by APIs.
    if (rawValue === null || rawValue === undefined || rawValue === "") continue;
    // Les objets/tableaux imbriqués (ex. un champ "data" qui recopie tout
    // l'enregistrement en JSON brut, comme sur VélÔToulouse) ne sont jamais
    // lisibles affichés tels quels dans un popup — on les ignore plutôt que
    // de balancer du JSON brut à l'écran.
    if (typeof rawValue === "object") continue;
    if (looksLikeSerializedJson(rawValue)) continue;
    const value = formatAttributeValue(rawValue);
    let groupName = "other";
    let label = key;
    for (const [prefix, target] of Object.entries(prefixes)) {
      if (key.startsWith(prefix)) {
        groupName = target;
        label = key.slice(prefix.length).trim();
        break;
      }
    }
    const item = `<div class="popup-attribute"><div class="popup-attribute-label">${esc(label)}</div><div class="popup-attribute-value">${esc(value)}</div></div>`;
    groups[groupName].push(item);
  }

  const section = (title, items) => items.length
    ? `<section class="popup-section"><div class="popup-section-title">${esc(title)}</div>${items.join("")}</section>`
    : "";

  const content = [
    section("Données réelles du dataset", groups.source),
    section("Informations du référentiel sélectionné", groups.reference),
    section("Jointure utilisée", groups.join),
    section("Autres attributs", groups.other)
  ].join("");

  const analysisLabel = props._analysis_label ? `<div class="popup-metric">${esc(props._analysis_label)}</div>` : "";
  return `<div class="popup-title">${esc(dataset.title)}</div>${analysisLabel}<div class="popup-scroll popup-stacked">${content || '<div class="popup-empty">Aucun attribut réel n’a été renvoyé par l’API.</div>'}</div>`;
}
/** Rôle : Extrait la valeur numérique utilisée pour dimensionner ou styliser une entité. */
function metricValue(feature) {
  return Number(feature.properties?._selected_metric_value || 0);
}
/** Rôle : Détermine le style Leaflet d'une entité selon son jeu et son rôle dans l'analyse. */
function styleFor(dataset, index, feature, analysisRole = "") {
  const color = analysisRole === "intersection" ? "#f59e0b" : palette[index % palette.length];
  const type = feature.geometry?.type || "";
  const metric = metricValue(feature);
  const radius = feature.properties?._selected_metric_value != null ? Math.min(18, 5 + Math.sqrt(Math.max(0, metric)) * 0.4) : 6;
  if (type.includes("Line")) return { color, weight: analysisRole ? 6 : 4, opacity: .9 };
  if (type.includes("Polygon")) return { color, weight: analysisRole ? 4 : 3, fillColor: color, fillOpacity: analysisRole ? .4 : .22 };
  return { color, weight: 2, fillColor: color, fillOpacity: .78, radius: analysisRole ? 7 : radius };
}
/** Rôle : Teste si un point appartient à un anneau polygonal. */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
/** Rôle : Teste si un point se trouve à l'intérieur de la géométrie de la zone sélectionnée. */
function pointInZoneGeometry(lng, lat, geometry) {
  if (!geometry) return false;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates]
    : geometry.type === "MultiPolygon" ? geometry.coordinates
    : [];
  for (const rings of polygons) {
    if (!rings.length || !pointInRing(lng, lat, rings[0])) continue;
    let inHole = false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lng, lat, rings[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}
/** Rôle : Parcourt récursivement une géométrie et collecte toutes ses coordonnées. */
function collectCoordinates(geometry, out = []) {
  if (!geometry) return out;
  const { type, coordinates } = geometry;
  if (type === "Point") out.push(coordinates);
  else if (type === "MultiPoint" || type === "LineString") (coordinates || []).forEach(c => out.push(c));
  else if (type === "MultiLineString" || type === "Polygon") (coordinates || []).forEach(ring => ring.forEach(c => out.push(c)));
  else if (type === "MultiPolygon") (coordinates || []).forEach(poly => poly.forEach(ring => ring.forEach(c => out.push(c))));
  else if (type === "GeometryCollection") (geometry.geometries || []).forEach(g => collectCoordinates(g, out));
  return out;
}
/** Rôle : Conserve les portions d'une ligne situées dans la zone sélectionnée. */
function clipLineToZone(coords, zoneGeometry) {
  const segments = [];
  let current = [];
  for (const coord of coords) {
    const [lng, lat] = coord;
    if (pointInZoneGeometry(lng, lat, zoneGeometry)) {
      current.push(coord);
    } else {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
/** Rôle : Découpe ou filtre une entité selon la zone géographique active. */
function clipFeatureToZone(feature, zoneGeometry) {
  const geometry = feature.geometry;
  if (!geometry) return null;
  // Les lignes sont réellement découpées à la frontière de la zone : on ne
  // garde que les portions dont les points tombent à l'intérieur, au lieu de
  // conserver la ligne entière dès qu'un seul point la traverse (ce qui
  // laissait des tracés s'étendre très loin hors de la zone demandée).
  if (geometry.type === "LineString") {
    const segments = clipLineToZone(geometry.coordinates, zoneGeometry);
    if (!segments.length) return null;
    return { ...feature, geometry: segments.length === 1 ? { type: "LineString", coordinates: segments[0] } : { type: "MultiLineString", coordinates: segments } };
  }
  if (geometry.type === "MultiLineString") {
    const allSegments = [];
    for (const line of geometry.coordinates || []) allSegments.push(...clipLineToZone(line, zoneGeometry));
    if (!allSegments.length) return null;
    return { ...feature, geometry: allSegments.length === 1 ? { type: "LineString", coordinates: allSegments[0] } : { type: "MultiLineString", coordinates: allSegments } };
  }
  // Points et polygones : pas de découpe fine, on garde la géométrie entière
  // si au moins un de ses points tombe réellement dans la zone.
  const coords = collectCoordinates(geometry);
  return coords.some(([lng, lat]) => pointInZoneGeometry(lng, lat, zoneGeometry)) ? feature : null;
}
/** Rôle : Vérifie si une entité intersecte l'emprise cartographique donnée. */
function geometryIntersectsBounds(feature, bounds) {
  try {
    const layer = L.geoJSON(feature);
    const featureBounds = layer.getBounds();
    return featureBounds.isValid() && bounds.intersects(featureBounds);
  } catch {
    return false;
  }
}
/** Rôle : Retourne les entités d'un jeu après application des filtres spatiaux actifs. */
function filteredData(entry) {
  if (!activeBounds) return entry.fullData;
  const features = [];
  for (const feature of entry.fullData.features || []) {
    if (!geometryIntersectsBounds(feature, activeBounds)) continue;
    if (!activeZoneGeometry) { features.push(feature); continue; }
    try {
      const clipped = clipFeatureToZone(feature, activeZoneGeometry);
      if (clipped) features.push(clipped);
    } catch {
      // Géométrie inattendue : on l'exclut plutôt que de faire planter l'affichage.
    }
  }
  return { ...entry.fullData, features };
}
/** Rôle : Crée ou actualise la couche Leaflet associée à un jeu de données. */
function renderEntry(entry, fit = false) {
  if (entry.layer) map.removeLayer(entry.layer);
  const data = filteredData(entry);
  entry.visibleData = data;
  entry.layer = L.geoJSON(data, {
    style: feature => styleFor(entry.dataset, entry.index, feature),
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, styleFor(entry.dataset, entry.index, feature)),
    onEachFeature: (feature, layer) => layer.bindPopup(popup(feature, entry.dataset, entry.selectedAttribute || ALL_ATTRIBUTES))
  });
  if (entry.enabled && !analysisActive) entry.layer.addTo(map);
  if (fit && entry.enabled && entry.layer.getBounds().isValid()) map.fitBounds(entry.layer.getBounds(), { padding: [30, 30] });
}
/** Rôle : Ajuste la carte à l'emprise d'un ensemble de couches. */
function fitLayers(layers) {
  if (!layers.length) return;
  const group = L.featureGroup(layers);
  const bounds = group.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [10, 10] });
}
/** Rôle : Ajuste la carte afin d'afficher toutes les couches actuellement visibles. */
function fitAll() {
  const layers = [];
  for (const entry of state.values()) if (entry.enabled && entry.layer && !analysisActive) layers.push(entry.layer);
  fitLayers(layers);
}
/** Rôle : Supprime les couches temporaires produites par l'analyse spatiale. */
function clearAnalysisLayers() {
  analysisLayers.forEach(item => map.removeLayer(item.layer));
  analysisLayers = [];
}
/** Rôle : Alimente les listes de sélection utilisées par les outils d'analyse. */
function populateAnalysisSelectors() {
  [analysisDatasetA, analysisDatasetB].forEach(select => { select.innerHTML = ""; });
  datasets.forEach((dataset, index) => {
    const optionA = document.createElement("option");
    optionA.value = dataset.id;
    optionA.textContent = dataset.title;
    analysisDatasetA.appendChild(optionA);
    const optionB = optionA.cloneNode(true);
    analysisDatasetB.appendChild(optionB);
    if (index === 1) analysisDatasetB.value = dataset.id;
  });
  if (datasets.length < 2) {
    viewModeInput.disabled = true;
    runAnalysisBtn.disabled = true;
    analysisResult.classList.remove("hidden");
    analysisResult.textContent = "Sélectionne au moins deux datasets pour lancer un croisement spatial.";
  } else {
    viewModeInput.disabled = false;
    runAnalysisBtn.disabled = false;
  }
}
/** Rôle : Met à jour les panneaux de contrôle selon les jeux chargés et les actions disponibles. */
function updatePanels() {
  const list = $("selectedDatasetsList");
  const legend = $("datasetLegend");
  const stats = $("datasetStats");
  list.innerHTML = "";
  legend.innerHTML = "";
  stats.innerHTML = "";
  let total = 0;
  let loaded = 0;

  datasets.forEach((dataset, index) => {
    const entry = state.get(dataset.id);
    const color = palette[index % palette.length];
    const count = entry?.visibleData?.features?.length || 0;
    if (entry?.fullData) loaded++;
    if (entry?.enabled && !analysisActive) total += count;
    const control = document.createElement("div");
    control.className = "dataset-layer-control";
    const toggle = document.createElement("label");
    toggle.className = "layer-toggle";
    toggle.innerHTML = `<input type="checkbox" ${entry?.enabled !== false ? "checked" : ""} ><span class="layer-color" style="background:${color}"></span><span>${esc(dataset.title)}</span>`;
    toggle.querySelector("input").addEventListener("change", event => {
      const currentEntry = state.get(dataset.id);
      if (!currentEntry) return;
      currentEntry.enabled = event.target.checked;
      if (!analysisActive) {
        if (currentEntry.enabled) currentEntry.layer?.addTo(map);
        else if (currentEntry.layer) map.removeLayer(currentEntry.layer);
      }
      updateTemporalCalendarRange();
      updatePanels();
    });
    control.appendChild(toggle);

    const attributeLabel = document.createElement("label");
    attributeLabel.className = "attribute-selector-label";
    attributeLabel.textContent = "Attribut affiché dans le popup";
    const attributeSelect = document.createElement("select");
    attributeSelect.className = "attribute-selector";
    attributeSelect.innerHTML = `<option value="${ALL_ATTRIBUTES}">Tous les attributs</option>`;
    for (const attribute of entry?.attributes || []) {
      const option = document.createElement("option");
      option.value = attribute;
      option.textContent = attribute;
      attributeSelect.appendChild(option);
    }
    attributeSelect.value = entry?.selectedAttribute || ALL_ATTRIBUTES;
    attributeSelect.disabled = !entry?.fullData;
    attributeSelect.addEventListener("change", event => {
      entry.selectedAttribute = event.target.value;
      if (analysisActive && lastAnalysis) renderAnalysis(lastAnalysis);
      else renderEntry(entry, false);
    });
    attributeLabel.appendChild(attributeSelect);
    control.appendChild(attributeLabel);

    // GPKG multi-couches (ex. BD TOPO : bâtiments, routes...) — sélecteur de
    // couche, affiché seulement si le fichier en propose plusieurs. Change de
    // couche via un rechargement de page (id composite "bd-topo::<couche>"),
    // le plus simple et fiable pour réutiliser toute la logique existante.
    const availableLayers = entry?.fullData?.metadata?.available_layers || [];
    if (availableLayers.length > 1) {
      const layerLabel = document.createElement("label");
      layerLabel.className = "attribute-selector-label";
      layerLabel.textContent = "Couche affichée";
      const layerSelect = document.createElement("select");
      layerSelect.className = "attribute-selector";
      const baseId = dataset.id.split("::")[0];
      for (const layerName of availableLayers) {
        const option = document.createElement("option");
        option.value = layerName;
        option.textContent = layerName;
        layerSelect.appendChild(option);
      }
      layerSelect.value = entry.fullData.metadata.active_layer || availableLayers[0];
      layerSelect.addEventListener("change", event => {
        const position = ids.indexOf(dataset.id);
        if (position === -1) return;
        const newIds = ids.slice();
        newIds[position] = `${baseId}::${event.target.value}`;
        const newParams = new URLSearchParams(location.search);
        const usesMultiParam = params.has("datasets");
        newParams.set(usesMultiParam ? "datasets" : "dataset", newIds.join(","));
        location.href = `${location.pathname}?${newParams.toString()}`;
      });
      layerLabel.appendChild(layerSelect);
      control.appendChild(layerLabel);
    }

    // Filtres de catégorie (ex. BD TOPO "batiment" : usage1/usage2) — deux
    // listes déroulantes indépendantes, affichées seulement quand la couche
    // active en propose. Rechargement ciblé de ce seul dataset (pas de
    // rechargement de page, contrairement au changement de couche) : plus
    // rapide et attendu vu que ça reste la même couche/géométrie.
    const availableCategories = entry?.fullData?.metadata?.available_categories || {};
    for (const [categoryField, values] of Object.entries(availableCategories)) {
      if (!values || !values.length) continue;
      const categoryLabel = document.createElement("label");
      categoryLabel.className = "attribute-selector-label";
      categoryLabel.textContent = `Filtrer par ${categoryField}`;
      const categorySelect = document.createElement("select");
      categorySelect.className = "attribute-selector";
      categorySelect.innerHTML = `<option value="">Tous</option>`;
      for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        categorySelect.appendChild(option);
      }
      categorySelect.value = (dataset.categoryFilters || {})[categoryField] || "";
      categorySelect.addEventListener("change", async event => {
        dataset.categoryFilters = dataset.categoryFilters || {};
        if (event.target.value) dataset.categoryFilters[categoryField] = event.target.value;
        else delete dataset.categoryFilters[categoryField];
        showMapLoading("Filtrage en cours", "Application du filtre de catégorie sélectionné.", "Ça ne prend qu'un instant.");
        try {
          await loadOne(dataset, index);
          updatePanels();
          fitAll();
          setStatus(`${datasets.length} couche(s) chargée(s) et superposée(s) sur la même carte.`, "ok");
        } catch (error) {
          setStatus(`${dataset.title} : ${error?.message || "erreur lors du filtrage"}`, "error");
        } finally {
          hideMapLoading();
        }
      });
      categoryLabel.appendChild(categorySelect);
      control.appendChild(categoryLabel);
    }
    list.appendChild(control);
    legend.insertAdjacentHTML("beforeend", `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span><span>${esc(dataset.title)}</span></div>`);
    const joinMeta = entry?.fullData?.metadata?.joined_dataset ? entry.fullData.metadata : null;
    const joinDetail = joinMeta
      ? `<div class="dataset-stat-detail">Entités source distinctes : ${fmt(joinMeta.source_records_loaded ?? "?")} · appariées au référentiel : ${fmt(joinMeta.source_records_matched ?? "?")} · entités référentiel retenues : ${fmt(joinMeta.reference_records_matched ?? "?")}${joinMeta.truncated ? " · ⚠️ résultat tronqué" : ""}</div>`
      : "";
    stats.insertAdjacentHTML("beforeend", `<div class="dataset-stat" style="--layer-color:${color}"><strong>${esc(dataset.title)}</strong>${fmt(count)} objet(s) chargé(s)${joinDetail}</div>`);
  });

  // Panneau partagé pour ajouter une couche GPKG multi-couches (ex. BD TOPO)
  // supplémentaire — un seul bouton, même si plusieurs couches du même
  // fichier sont déjà chargées, plutôt qu'un bouton répété sur chaque carte.
  const multiLayerBaseIds = new Set(
    datasets
      .map(dataset => ({ dataset, entry: state.get(dataset.id) }))
      .filter(({ entry }) => (entry?.fullData?.metadata?.available_layers || []).length > 1)
      .map(({ dataset }) => dataset.id.split("::")[0])
  );
  for (const baseId of multiLayerBaseIds) {
    const referenceEntry = [...state.values()].find(entry => entry?.dataset?.id?.split("::")[0] === baseId && entry.fullData?.metadata?.available_layers?.length > 1);
    const availableLayers = referenceEntry?.fullData?.metadata?.available_layers || [];
    const baseTitle = (referenceEntry?.dataset?.title || baseId).split(" — ")[0];
    const loadedLayers = new Set(datasets.filter(d => d.id.split("::")[0] === baseId).map(d => d.id.split("::")[1]));
    const remainingLayers = availableLayers.filter(layerName => !loadedLayers.has(layerName));
    if (!remainingLayers.length) continue;

    const addLayerPanel = document.createElement("div");
    addLayerPanel.className = "dataset-layer-control add-layer-panel";
    const addLayerTitle = document.createElement("div");
    addLayerTitle.className = "attribute-selector-label";
    addLayerTitle.textContent = `Ajouter une couche ${baseTitle}`;
    const addLayerSelect = document.createElement("select");
    addLayerSelect.className = "attribute-selector";
    for (const layerName of remainingLayers) {
      const option = document.createElement("option");
      option.value = layerName;
      option.textContent = layerName;
      addLayerSelect.appendChild(option);
    }
    const addLayerBtn = document.createElement("button");
    addLayerBtn.type = "button";
    addLayerBtn.className = "secondary-btn";
    addLayerBtn.textContent = "+ Ajouter cette couche en parallèle";
    addLayerBtn.style.marginTop = "6px";
    addLayerBtn.addEventListener("click", async () => {
      const newId = `${baseId}::${addLayerSelect.value}`;
      if (datasets.some(existing => existing.id === newId)) {
        setStatus("Cette couche est déjà chargée.", "error");
        return;
      }
      const newDataset = { id: newId, title: `${baseTitle} — ${addLayerSelect.value}` };
      datasets.push(newDataset);
      ids.push(newId);
      showMapLoading("Chargement de la couche", `Ajout de la couche "${addLayerSelect.value}" sur la carte.`, "Ça peut prendre un moment sur un gros fichier.");
      try {
        await loadOne(newDataset, datasets.length - 1);
        updatePanels();
        fitAll();
        populateAnalysisSelectors();
        setStatus(`${datasets.length} couche(s) chargée(s) et superposée(s) sur la même carte.`, "ok");
      } catch (error) {
        datasets.pop();
        ids.pop();
        setStatus(`${newDataset.title} : ${error?.message || "erreur lors du chargement"}`, "error");
      } finally {
        hideMapLoading();
      }
    });
    addLayerPanel.appendChild(addLayerTitle);
    addLayerPanel.appendChild(addLayerSelect);
    addLayerPanel.appendChild(addLayerBtn);
    list.appendChild(addLayerPanel);
  }

  if (analysisActive && lastAnalysis) {
    total = lastAnalysis.layers.reduce((sum, layer) => sum + (layer.geojson?.features?.length || 0), 0);
    legend.insertAdjacentHTML("beforeend", `<div class="legend-item"><span class="legend-swatch" style="background:#f59e0b"></span><span>Résultat d’intersection</span></div>`);
  }
  $("loadedLayerCount").textContent = loaded;
  $("featureCount").textContent = total;
}
/** Rôle : Charge un jeu de données et prépare sa couche, ses attributs et ses paramètres temporels. */
async function loadOne(dataset, index) {
  const query = new URLSearchParams({ title: dataset.title });
  if (temporalDatasetIds.has(dataset.id)) {
    if (dateInput.value) query.set("date", dateInput.value);
    if (hourInput.value) query.set("time", hourInput.value);
  }
  if (dataset.id === temporalId) {
    query.set("hour", String(Number((hourInput.value || "01:00").split(":")[0])));
    query.set("metric", metricInput.value || "all");
  }
  // Filtres de catégorie (ex. BD TOPO "batiment" : usage1/usage_1...), choisis
  // via les listes déroulantes dédiées — voir updatePanels(). Noms de colonnes
  // réels, pas de nom en dur ici.
  for (const [key, value] of Object.entries(dataset.categoryFilters || {})) {
    query.set(key, value);
  }
  let endpoint = `/api/dataset/${encodeURIComponent(dataset.id)}?${query}`;
  let isJoinCall = false;
  const perDatasetJoin = datasetJoinInfo.get(dataset.id);
  if (perDatasetJoin) {
    isJoinCall = true;
    const referenceQuery = new URLSearchParams({
      title: dataset.title,
      source_title: dataset.title,
      reference_title: perDatasetJoin.referenceTitle,
      source_field: perDatasetJoin.sourceField,
      target_field: perDatasetJoin.targetField
    });
    if (temporalDatasetIds.has(dataset.id)) {
      if (dateInput.value) referenceQuery.set("date", dateInput.value);
      if (hourInput.value) referenceQuery.set("time", hourInput.value);
    }
    endpoint = `/api/join-reference/${encodeURIComponent(dataset.id)}/${encodeURIComponent(perDatasetJoin.referenceTarget)}?${referenceQuery}`;
  } else if (referenceTarget && datasets.length === 1 && referenceSourceField && referenceTargetField) {
    isJoinCall = true;
    const referenceQuery = new URLSearchParams({
      title: dataset.title,
      source_title: referenceSourceTitle || dataset.title,
      reference_title: referenceTitle,
      source_field: referenceSourceField,
      target_field: referenceTargetField
    });
    if (temporalDatasetIds.has(dataset.id)) {
      if (dateInput.value) referenceQuery.set("date", dateInput.value);
      if (hourInput.value) referenceQuery.set("time", hourInput.value);
    }
    endpoint = `/api/join-reference/${encodeURIComponent(dataset.id)}/${encodeURIComponent(referenceTarget)}?${referenceQuery}`;
  } else if (referenceSource && datasets.length === 1 && referenceSourceField && referenceTargetField) {
    isJoinCall = true;
    // Compatibilité avec les anciens liens qui affichaient seulement le référentiel filtré.
    const referenceQuery = new URLSearchParams({
      title: dataset.title,
      source_title: referenceSourceTitle,
      source_field: referenceSourceField,
      target_field: referenceTargetField
    });
    if (temporalDatasetIds.has(referenceSource)) {
      if (dateInput.value) referenceQuery.set("date", dateInput.value);
      if (hourInput.value) referenceQuery.set("time", hourInput.value);
    }
    endpoint = `/api/join-reference/${encodeURIComponent(referenceSource)}/${encodeURIComponent(dataset.id)}?${referenceQuery}`;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  let response;
  let data;
  try {
    response = await fetch(endpoint, { signal: controller.signal });
    const contentType = response.headers.get("content-type") || "";
    data = contentType.includes("application/json")
      ? await response.json()
      : { error: (await response.text()).slice(0, 500) || "Réponse serveur non JSON" };
  } catch (error) {
    if (error?.name === "AbortError") {
      const reason = isJoinCall ? "pendant la jointure" : "pendant le chargement des données";
      throw new Error(`${dataset.title} : le serveur a dépassé 5 minutes ${reason}. La requête a été arrêtée.`);
    }
    throw new Error(`${dataset.title} : ${error?.message || "erreur réseau"}`);
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    const detailsText = data.details && typeof data.details === "object"
      ? `champ demandé : ${data.details.source_field_demande ?? "?"} · champs trouvés : ${(data.details.champs_trouves || []).join(", ") || "aucun"} · enregistrements analysés : ${data.details.nb_enregistrements_source ?? "?"}`
      : (data.details || "");
    throw new Error(`${dataset.title} : ${data.error || detailsText || "chargement impossible"}${detailsText && data.error ? ` (${detailsText})` : ""}`);
  }
  const temporal = data?.metadata?.temporal;
  if (temporalFeedback && temporal?.match_type) {
    if (temporal.match_type === "exact") {
      temporalFeedback.textContent = `Mesure exacte affichée : ${temporal.selected_datetime || temporal.requested_datetime}.`;
    } else if (temporal.match_type === "nearest_same_date") {
      temporalFeedback.textContent = `Aucune mesure à l’heure exacte. Heure la plus proche le même jour : ${temporal.selected_datetime}.`;
    }
  }
  const entry = state.get(dataset.id) || { dataset, index, enabled: true, selectedAttribute: ALL_ATTRIBUTES };
  entry.fullData = data;
  entry.attributes = availableAttributes(data);
  if (entry.selectedAttribute !== ALL_ATTRIBUTES && !entry.attributes.includes(entry.selectedAttribute)) entry.selectedAttribute = ALL_ATTRIBUTES;
  state.set(dataset.id, entry);
  renderEntry(entry, false);
  if (data?.metadata?.filtered_reference && (data.features?.length || 0) === 1) {
    setTimeout(() => {
      const layers = entry.layer?.getLayers?.() || [];
      if (layers[0]?.openPopup) layers[0].openPopup();
    }, 250);
  }
  return data.features?.length || 0;
}
/** Rôle : Affiche l'indicateur de chargement de la carte avec un message adapté. */
function showMapLoading(
  title = "Préparation de la visualisation",
  message = "Les données géographiques sont en cours de téléchargement et d’affichage sur la carte.",
  detail = "Merci de patienter, le temps de chargement dépend de la taille des datasets."
){
  if (mapLoadingTitle) mapLoadingTitle.textContent = title;
  if (mapLoadingMessage) mapLoadingMessage.textContent = message;
  if (mapLoadingDetail) mapLoadingDetail.textContent = detail;
  if (mapLoading) mapLoading.classList.remove("is-hidden");
}
/** Rôle : Masque l'indicateur de chargement de la carte. */
function hideMapLoading(){
  if (mapLoading) mapLoading.classList.add("is-hidden");
}

/** Rôle : Charge tous les jeux demandés puis initialise les contrôles et l'affichage cartographique. */
async function loadAll() {
  if (referenceTarget) {
    showMapLoading(
      "Construction de la jointure cartographique",
      "Les attributs du dataset analysé sont associés aux attributs et à la géométrie du meilleur référentiel.",
      "La carte affichera le résultat fusionné des deux datasets."
    );
  } else {
    showMapLoading();
  }
  if (!datasets.length) {
    setStatus("Aucun dataset n’a été sélectionné.", "error");
    hideMapLoading();
    return;
  }
  restoreAllData(false);
  setStatus(`Chargement de ${datasets.length} couche(s)...`);
  if (reloadBtn) reloadBtn.disabled = true;
  activeBounds = null;
  activeZoneGeometry = null;
  removeZone();
  $("resetSpatialFilterBtn").disabled = true;
  try {
    const results = await Promise.allSettled(datasets.map(loadOne));
    const errors = results.filter(result => result.status === "rejected");
    updatePanels();
    fitAll();
    if (errors.length) {
      const message = `${datasets.length - errors.length} couche(s) chargée(s), ${errors.length} erreur(s) : ${errors.map(error => error.reason.message).join(" | ")}`;
      const isMissingDataError = errors.some(error => /aucune donn[ée]e n.?est disponible/i.test(error.reason?.message || ""));
      const window = isMissingDataError ? computeActiveTemporalWindow() : null;
      if (window?.hasCommonRange) {
        const label = window.activeRanges.length > 1
          ? `📅 Utiliser la dernière période commune (${window.commonMax})`
          : `📅 Utiliser la dernière date disponible (${window.commonMax})`;
        setStatus(message, "error", label, useLatestCommonPeriod);
      } else {
        setStatus(message, "error");
      }
    }
    else setStatus(`${datasets.length} couche(s) chargée(s) et superposée(s) sur la même carte.`, "ok");
  } finally {
    if (reloadBtn) reloadBtn.disabled = false;
    hideMapLoading();
  }
}
/** Rôle : Affiche le résumé d'une analyse spatiale réussie. */
function showAnalysisResult(result) {
  const summary = result.summary || {};
  analysisResult.classList.remove("hidden", "error");
  if (result.mode === "multi") {
    const rows = Object.entries(summary.matched_by_dataset || {}).map(([id, count]) => {
      const title = state.get(id)?.dataset?.title || id;
      return `<div class="analysis-metric"><b>${fmt(count)}</b>objet(s) — ${esc(title)}</div>`;
    }).join("");
    analysisResult.innerHTML = `
      <strong>${esc(result.relation_label || "Croisement multiple")}</strong>
      <div>${fmt(summary.dataset_count)} dataset(s) analysé(s). Toutes les paires possibles sont comparées ; les zones orange correspondent aux croisements trouvés.</div>
      <div class="analysis-metrics">
        <div class="analysis-metric"><b>${fmt(summary.nonempty_pair_count || 0)}</b>paire(s) avec un croisement sur ${fmt(summary.pair_count || 0)}</div>
        ${rows}
      </div>`;
    return;
  }
  const isOverlay = result.operation === "overlay_intersection";
  analysisResult.innerHTML = `
    <strong>${esc(result.relation_label || "Croisement spatial")}</strong>
    <div>Géométries détectées : ${esc(result.geometry_types?.dataset_a || "?")} + ${esc(result.geometry_types?.dataset_b || "?")}.</div>
    <div class="analysis-metrics">
      ${isOverlay ? `<div class="analysis-metric"><b>${fmt(summary.intersection_geometries)}</b>zone(s) d’intersection</div>` : `
      <div class="analysis-metric"><b>${fmt(summary.dataset_a_matched)}</b>objet(s) correspondant(s) dans A</div>
      <div class="analysis-metric"><b>${fmt(summary.dataset_b_matched)}</b>objet(s) correspondant(s) dans B</div>`}
    </div>`;
}
/** Rôle : Affiche un message d'erreur lié à l'analyse spatiale. */
function showAnalysisError(message) {
  analysisResult.classList.remove("hidden");
  analysisResult.classList.add("error");
  analysisResult.innerHTML = `<strong>Analyse impossible</strong>${esc(message)}`;
}
/** Rôle : Affiche sur la carte les couches et résultats produits par l'analyse. */
function renderAnalysis(result) {
  clearAnalysisLayers();
  for (const entry of state.values()) if (entry.layer) map.removeLayer(entry.layer);
  analysisActive = true;
  lastAnalysis = result;
  (result.layers || []).forEach((resultLayer, index) => {
    const dataset = { id: resultLayer.id, title: resultLayer.title };
    const layer = L.geoJSON(resultLayer.geojson, {
      style: feature => styleFor(dataset, index, feature, resultLayer.role),
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, styleFor(dataset, index, feature, resultLayer.role)),
      onEachFeature: (feature, leafletLayer) => leafletLayer.bindPopup(popup(feature, dataset, state.get(resultLayer.id)?.selectedAttribute || ALL_ATTRIBUTES))
    }).addTo(map);
    analysisLayers.push({ layer, dataset, role: resultLayer.role });
  });
  fitLayers(analysisLayers.map(item => item.layer));
  updatePanels();
  showAnalysisResult(result);
}
/** Rôle : Lance l'analyse spatiale automatique entre les jeux choisis. */
async function runAutomaticAnalysis() {
  const idA = analysisDatasetA.value;
  const idB = analysisDatasetB.value;
  if (!idA || !idB || idA === idB) {
    showAnalysisError("Choisis deux datasets différents.");
    return;
  }
  const entryA = state.get(idA);
  const entryB = state.get(idB);
  if (!entryA?.fullData || !entryB?.fullData) {
    showAnalysisError("Les deux datasets ne sont pas encore chargés.");
    return;
  }
  runAnalysisBtn.disabled = true;
  runMultiAnalysisBtn.disabled = true;
  showMapLoading(
    "Analyse spatiale intelligente en cours",
    "Détection des géométries et calcul du croisement entre les datasets A et B.",
    "Merci de patienter : la durée dépend du nombre d’objets et de la complexité des géométries."
  );
  setStatus("Détection des géométries et calcul du croisement spatial...");
  try {
    const response = await fetch("/api/spatial-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_a: { id: idA, title: entryA.dataset.title },
        dataset_b: { id: idB, title: entryB.dataset.title },
        collection_a: filteredData(entryA),
        collection_b: filteredData(entryB),
        distance_m: Number(analysisDistance.value || 100)
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.details || result.error || "Le calcul a échoué.");
    renderAnalysis(result);
    setStatus(`${result.relation_label} : analyse terminée.`, "ok");
  } catch (error) {
    showAnalysisError(error.message);
    setStatus(error.message, "error");
  } finally {
    runAnalysisBtn.disabled = false;
    runMultiAnalysisBtn.disabled = false;
    hideMapLoading();
  }
}
/** Rôle : Lance l'analyse spatiale combinée sur plusieurs jeux de données. */
async function runMultiAnalysis() {
  const selectedEntries = [...state.values()].filter(entry => entry.enabled && entry.fullData);
  if (selectedEntries.length < 2) {
    showAnalysisError("Coche au moins deux couches dans la liste des datasets sélectionnés.");
    return;
  }
  runMultiAnalysisBtn.disabled = true;
  runAnalysisBtn.disabled = true;
  showMapLoading(
    "Analyse spatiale multiple en cours",
    `Croisement des ${selectedEntries.length} couches cochées et comparaison de toutes les paires possibles.`,
    "Merci de patienter : cette analyse peut prendre davantage de temps selon la taille des datasets."
  );
  setStatus(`Calcul de l’intersection commune de ${selectedEntries.length} datasets...`);
  try {
    const response = await fetch("/api/spatial-analysis-multi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        datasets: selectedEntries.map(entry => ({
          dataset: { id: entry.dataset.id, title: entry.dataset.title },
          collection: filteredData(entry)
        })),
        distance_m: Number(analysisDistance.value || 100)
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.details || result.error || "Le calcul multiple a échoué.");
    renderAnalysis(result);
    setStatus(`${result.relation_label} : analyse terminée.`, "ok");
  } catch (error) {
    showAnalysisError(error.message);
    setStatus(error.message, "error");
  } finally {
    runMultiAnalysisBtn.disabled = false;
    runAnalysisBtn.disabled = false;
    hideMapLoading();
  }
}

/** Rôle : Restaure les données complètes après suppression des filtres spatiaux. */
function restoreAllData(updateMode = true) {
  clearAnalysisLayers();
  analysisActive = false;
  lastAnalysis = null;
  for (const entry of state.values()) if (entry.enabled && entry.layer) entry.layer.addTo(map);
  if (updateMode) viewModeInput.value = "all";
  analysisResult.classList.add("hidden");
  updatePanels();
  fitAll();
}
/** Rôle : Applique une emprise ou une zone nommée comme filtre spatial. */
function applyBounds(bounds, label, zoneGeometry = null) {
  activeBounds = bounds;
  activeZoneGeometry = zoneGeometry;
  restoreAllData();
  for (const entry of state.values()) renderEntry(entry, false);
  updatePanels();
  fitAll();
  // fitAll() cale la vue sur les données affichées, qui peuvent occuper
  // moins de place que la zone entière selon leur répartition. Pour garantir
  // que la zone demandée (ex. Blagnac) remplit bien l'écran et reste centrée,
  // peu importe où se trouvent les données à l'intérieur, on recale la vue
  // en dernier sur le contour de la zone elle-même, avec une marge minimale.
  map.fitBounds(bounds, { padding: [4, 4] });
  $("resetSpatialFilterBtn").disabled = false;
  $("spatialFilterStatus").textContent = `Filtre appliqué à toutes les couches : ${label}.`;
  setStatus("Le filtre spatial a été appliqué à tous les datasets.", "ok");
}
/** Rôle : Supprime la zone de filtrage et réaffiche les données complètes. */
function removeZone() {
  if (zoneLayer) {
    map.removeLayer(zoneLayer);
    zoneLayer = null;
  }
}
/** Rôle : Recherche une commune ou un lieu afin de récupérer son emprise géographique. */
async function searchZone() {
  const query = $("namedZoneInput").value.trim();
  if (query.length < 2) {
    setStatus("Saisis au moins deux caractères.", "error");
    return;
  }
  const response = await fetch(`/api/zone-search?q=${encodeURIComponent(query)}`);
  const data = await response.json();
  if (!response.ok) {
    setStatus(data.error || "Recherche impossible.", "error");
    return;
  }
  searchResults = data.results || [];
  const select = $("namedZoneResults");
  select.innerHTML = "";
  searchResults.forEach((zone, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = zone.display_name;
    select.appendChild(option);
  });
  $("namedZoneResultsWrap").classList.toggle("hidden", !searchResults.length);
  setStatus(searchResults.length ? `${searchResults.length} zone(s) trouvée(s).` : "Aucune zone trouvée.", searchResults.length ? "ok" : "error");
}
/** Rôle : Applique à la carte la zone choisie dans les résultats de recherche. */
function applyZone() {
  const zone = searchResults[Number($("namedZoneResults").value)];
  if (!zone) return;
  removeZone();
  if (zone.geometry) zoneLayer = L.geoJSON({ type: "Feature", properties: {}, geometry: zone.geometry }, { style: { color: "#111827", weight: 3, fillOpacity: .05, dashArray: "7 5" } }).addTo(map);
  else zoneLayer = L.rectangle([[zone.bbox.south, zone.bbox.west], [zone.bbox.north, zone.bbox.east]], { color: "#111827", weight: 3, fillOpacity: .05, dashArray: "7 5" }).addTo(map);
  const bounds = zoneLayer.getBounds();
  map.fitBounds(bounds, { padding: [20, 20] });
  applyBounds(bounds, zone.display_name, zone.geometry || null);
}

viewModeInput.addEventListener("change", () => {
  const automatic = viewModeInput.value === "automatic";
  analysisControls.classList.toggle("hidden", !automatic);
  if (!automatic) restoreAllData(false);
});
runAnalysisBtn.addEventListener("click", runAutomaticAnalysis);
runMultiAnalysisBtn.addEventListener("click", runMultiAnalysis);
restoreAllBtn.addEventListener("click", () => restoreAllData());
$("searchNamedZoneBtn").addEventListener("click", searchZone);
$("namedZoneInput").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); searchZone(); } });
$("applyNamedZoneBtn").addEventListener("click", applyZone);
$("applyMapBoundsBtn").addEventListener("click", () => applyBounds(map.getBounds(), "emprise visible"));
$("resetSpatialFilterBtn").addEventListener("click", () => {
  activeBounds = null;
  activeZoneGeometry = null;
  removeZone();
  restoreAllData();
  for (const entry of state.values()) renderEntry(entry, false);
  updatePanels();
  fitAll();
  $("resetSpatialFilterBtn").disabled = true;
  $("spatialFilterStatus").textContent = "Aucune limite spatiale appliquée.";
  setStatus("Toutes les données sont de nouveau affichées.", "ok");
});
if (reloadBtn) reloadBtn.addEventListener("click", loadAll);
if (latestCommonBtn) latestCommonBtn.addEventListener("click", useLatestCommonPeriod);
/** Rôle : Active ou masque les champs de période selon le mode temporel sélectionné. */
function togglePeriodRangeInputs() {
  const isRange = periodModeRange?.checked;
  if (periodRangeInputs) periodRangeInputs.classList.toggle("hidden", !isRange);
  if (!isRange) {
    // Repasser sur "Afficher tout" efface les dates choisies : au prochain
    // clic sur "Actualiser", plus aucun filtre de période n'est envoyé.
    if (periodStartInput) periodStartInput.value = "";
    if (periodEndInput) periodEndInput.value = "";
  }
}
if (periodModeAll) periodModeAll.addEventListener("change", togglePeriodRangeInputs);
if (periodModeRange) periodModeRange.addEventListener("change", togglePeriodRangeInputs);
if (periodReloadBtn) periodReloadBtn.addEventListener("click", loadAll);

const EXPORT_FORMAT_OPTIONS = [
  { value: "geojson", label: "GeoJSON" },
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "Excel (XLSX)" },
  { value: "gpkg", label: "GeoPackage (GPKG)" },
  { value: "shp", label: "Shapefile (ZIP)" },
  { value: "kml", label: "KML" },
  { value: "parquet", label: "Parquet" },
];

/** Rôle : Crée la boîte de dialogue d'export si elle n'est pas encore présente. */
function ensureExportDialog() {
  if ($("exportDialogOverlay")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="exportDialogOverlay" class="export-dialog-overlay" hidden>
      <div class="export-dialog" role="dialog" aria-modal="true" aria-labelledby="exportDialogTitle">
        <h3 id="exportDialogTitle">Choisir le format d'export</h3>
        <p class="export-dialog-intro">Un fichier séparé par dataset chargé. Le format déclaré par la source est présélectionné, mais tu peux choisir n'importe quel autre format pour chacun.</p>
        <div id="exportDialogList" class="export-dialog-list"></div>
        <div class="export-dialog-actions">
          <button id="exportDialogCancel" type="button" class="secondary">Annuler</button>
          <button id="exportDialogConfirm" type="button">Exporter</button>
        </div>
      </div>
    </div>
  `);
  $("exportDialogCancel").addEventListener("click", () => { $("exportDialogOverlay").hidden = true; });
  $("exportDialogConfirm").addEventListener("click", confirmExportDialog);
}

/** Rôle : Ouvre la boîte de dialogue et prépare les options d'export disponibles. */
function openExportDialog() {
  const entries = [...state.values()].filter(entry => entry.enabled);
  const exportStatus = $("exportStatus");
  if (!entries.length) {
    if (exportStatus) exportStatus.textContent = "Aucune couche chargée à exporter.";
    return;
  }
  ensureExportDialog();

  // Le croisement générique ne s'applique que si l'analyse spatiale à 2
  // datasets est active ET que les deux datasets analysés sont bien parmi
  // les couches actuellement chargées (pas seulement pour zone de rencontre
  // / interventions : n'importe quelle paire croisée fonctionne pareil).
  let crossA = "", crossB = "";
  if (analysisActive && lastAnalysis && lastAnalysis.mode === "automatic") {
    const idA = analysisDatasetA?.value;
    const idB = analysisDatasetB?.value;
    if (entries.some(e => e.dataset.id === idA) && entries.some(e => e.dataset.id === idB)) {
      crossA = idA;
      crossB = idB;
    }
  }

  const list = $("exportDialogList");
  list.innerHTML = entries.map(entry => {
    const id = entry.dataset.id;
    const declared = datasetExportFormats.get(id) || "geojson";
    const isCrossMember = id === crossA || id === crossB;
    const options = EXPORT_FORMAT_OPTIONS.map(opt =>
      `<option value="${opt.value}" ${opt.value === declared ? "selected" : ""}>${opt.label}</option>`
    ).join("");
    return `
      <div class="export-dialog-row" data-dataset-id="${esc(id)}">
        <div class="export-dialog-row-title">${esc(entry.dataset.title)}${isCrossMember ? ' <span class="export-cross-badge">+ données croisées</span>' : ""}</div>
        <select class="export-format-select">${options}</select>
      </div>
    `;
  }).join("");

  const overlay = $("exportDialogOverlay");
  overlay.dataset.crossA = crossA;
  overlay.dataset.crossB = crossB;
  overlay.hidden = false;
}

/** Rôle : Transforme un libellé en nom de fichier compatible avec le téléchargement. */
function slugifyForFilename(text) {
  return String(text || "dataset")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "dataset";
}
/** Rôle : Déclenche dans le navigateur le téléchargement d'un contenu binaire. */
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const EXPORT_EXTENSIONS = { gpkg: "gpkg", shp: "zip", kml: "kml", csv: "csv", xlsx: "xlsx", parquet: "parquet", geojson: "geojson" };
/** Rôle : Exporte un jeu de données unique dans le format choisi. */
async function exportOneDataset(entry, format) {
  const data = entry.visibleData || entry.fullData;
  if (!data) return { title: entry.dataset.title, ok: false, error: "Aucune donnée chargée." };
  const filename = slugifyForFilename(entry.dataset.title);
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geojson: data, format, filename })
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      return { title: entry.dataset.title, ok: false, error: errorPayload.error || `Erreur HTTP ${response.status}` };
    }
    const blob = await response.blob();
    const extension = format === "shp" ? "_shp.zip" : `.${EXPORT_EXTENSIONS[format] || "geojson"}`;
    downloadBlob(`${filename}${extension}`, blob);
    return { title: entry.dataset.title, ok: true, format };
  } catch (error) {
    return { title: entry.dataset.title, ok: false, error: error.message };
  }
}
// Générique : valable pour n'importe quelle paire de datasets croisés, pas
// seulement une combinaison particulière. "baseEntry" est le dataset dont on
// garde toutes les entités (y compris celles sans correspondance, avec les
// colonnes de l'autre laissées vides) ; "otherEntry" est fusionné dedans.
/** Rôle : Exporte le résultat du croisement entre deux jeux de données. */
async function exportCrossReference(baseEntry, otherEntry, format) {
  if (!baseEntry?.fullData || !otherEntry?.fullData) {
    return { title: baseEntry?.dataset?.title || "?", ok: false, error: "Les deux datasets ne sont pas encore chargés." };
  }
  const filename = slugifyForFilename(baseEntry.dataset.title);
  try {
    const response = await fetch("/api/export-cross-reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_a: { id: baseEntry.dataset.id, title: baseEntry.dataset.title },
        dataset_b: { id: otherEntry.dataset.id, title: otherEntry.dataset.title },
        collection_a: filteredData(baseEntry),
        collection_b: filteredData(otherEntry),
        base: "a",
        format,
        distance_m: Number(analysisDistance?.value || 100)
      })
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      return { title: baseEntry.dataset.title, ok: false, error: errorPayload.error || `Erreur HTTP ${response.status}` };
    }
    const blob = await response.blob();
    const extension = format === "shp" ? "_shp.zip" : `.${EXPORT_EXTENSIONS[format] || "geojson"}`;
    downloadBlob(`${filename}${extension}`, blob);
    return { title: baseEntry.dataset.title, ok: true, format };
  } catch (error) {
    return { title: baseEntry.dataset.title, ok: false, error: error.message };
  }
}
/** Rôle : Valide les choix de l'utilisateur et lance l'export demandé. */
async function confirmExportDialog() {
  const overlay = $("exportDialogOverlay");
  const rows = [...overlay.querySelectorAll(".export-dialog-row")];
  const chosen = rows.map(row => ({
    id: row.dataset.datasetId,
    format: row.querySelector(".export-format-select").value
  }));
  const crossA = overlay.dataset.crossA;
  const crossB = overlay.dataset.crossB;
  overlay.hidden = true;

  const exportStatus = $("exportStatus");
  const exportBtn = $("exportDataBtn");
  if (exportBtn) exportBtn.disabled = true;
  if (exportStatus) exportStatus.textContent = `Export de ${chosen.length} dataset(s) en cours…`;

  const results = await Promise.all(chosen.map(({ id, format }) => {
    const entry = state.get(id);
    if (!entry) return Promise.resolve({ title: id, ok: false, error: "Dataset introuvable." });
    if (crossA && crossB && (id === crossA || id === crossB)) {
      const otherId = id === crossA ? crossB : crossA;
      return exportCrossReference(entry, state.get(otherId), format);
    }
    return exportOneDataset(entry, format);
  }));

  if (exportBtn) exportBtn.disabled = false;
  if (exportStatus) {
    const failed = results.filter(r => !r.ok);
    if (!failed.length) {
      exportStatus.textContent = `${results.length} fichier(s) téléchargé(s) : ${results.map(r => `${r.title} (${r.format})`).join(", ")}.`;
    } else {
      exportStatus.textContent = `${results.length - failed.length} fichier(s) téléchargé(s), ${failed.length} échec(s) : ${failed.map(r => `${r.title} — ${r.error}`).join(" | ")}`;
    }
  }
}
if ($("exportDataBtn")) $("exportDataBtn").addEventListener("click", openExportDialog);
// Date and time are intentionally applied only with the update button. This
// allows keyboard entry of HH:MM without launching an incomplete request.
metricInput.addEventListener("change", () => { if (datasets.some(dataset => dataset.id === temporalId)) loadAll(); });

populateAnalysisSelectors();
initializeTemporalControls().finally(loadAll);
