const pageParams = new URLSearchParams(window.location.search);
const datasetId = pageParams.get("dataset") || "comptages-routiers-et-pietons-2025";
const datasetTitle = pageParams.get("title") || datasetId;

const map = L.map("map").setView([43.6047, 1.4442], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let dataLayer = null;
let geojsonData = null;
let fullGeojsonData = null;
let activeSpatialBounds = null;
let activeNamedZone = null;
let namedZoneLayer = null;
let namedZoneResultsData = [];
let selectedPopupProperty = "";
let currentMaxMetric = 1;
const isZonesRencontreDataset = datasetId === "zones-de-rencontre";
const isVelotoulouseDataset = datasetId === "velotoulouse-localisation-et-caracteristique-des-stations";
const isEspacesVertsDataset = datasetId === "espaces-verts";
const isParcsStationnementDataset = datasetId === "parcs-de-stationnement";
const isTemporalCountsDataset = datasetId === "comptages-routiers-et-pietons-2025";
const isStaticDataset = !isTemporalCountsDataset;

const statusEl = document.getElementById("status");
const statusCard = document.querySelector(".status-card");
const featureCountEl = document.getElementById("featureCount");
const apiTotalEl = document.getElementById("apiTotal");
const metricTotalEl = document.getElementById("metricTotal");
const periodLabelEl = document.getElementById("periodLabel");
const propertyFilter = document.getElementById("propertyFilter");
const dateInput = document.getElementById("dateInput");
const hourInput = document.getElementById("hourInput");
const metricInput = document.getElementById("metricInput");
const reloadBtn = document.getElementById("reloadBtn");
const temporalControls = document.getElementById("temporalControls");
const statsHelp = document.getElementById("statsHelp");
const metricLine = document.getElementById("metricLine");
const legendHelp = document.getElementById("legendHelp");
const applyMapBoundsBtn = document.getElementById("applyMapBoundsBtn");
const resetSpatialFilterBtn = document.getElementById("resetSpatialFilterBtn");
const spatialFilterStatus = document.getElementById("spatialFilterStatus");
const namedZoneInput = document.getElementById("namedZoneInput");
const searchNamedZoneBtn = document.getElementById("searchNamedZoneBtn");
const namedZoneResultsWrap = document.getElementById("namedZoneResultsWrap");
const namedZoneResults = document.getElementById("namedZoneResults");
const applyNamedZoneBtn = document.getElementById("applyNamedZoneBtn");

for (let h = 0; h < 24; h += 1) {
  const option = document.createElement("option");
  option.value = String(h);
  option.textContent = `${String(h).padStart(2, "0")}:00 - ${String((h + 1) % 24).padStart(2, "0")}:00`;
  if (h === 1) option.selected = true;
  hourInput.appendChild(option);
}

/** Rôle : Met à jour le message d'état et l'action éventuelle affichés à l'utilisateur. */
function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusCard.classList.remove("ok", "error");
  if (type) statusCard.classList.add(type);
}

/** Rôle : Échappe les caractères HTML afin d'éviter une insertion non sûre. */
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Rôle : Formate une propriété pour son affichage dans une infobulle. */
function formatValue(value) {
  if (value === null || value === undefined || value === "") return "Non renseigné";
  if (typeof value === "object") return escapeHtml(JSON.stringify(value));
  return escapeHtml(value);
}

/** Rôle : Formate une valeur numérique avec une précision lisible. */
function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n);
}

/** Rôle : Extrait la valeur numérique utilisée pour dimensionner ou styliser une entité. */
function metricValue(feature) {
  return Number(feature.properties?._selected_metric_value || 0);
}

/** Rôle : Vérifie si l'entité contient un indicateur de comptage exploitable. */
function hasCountMetric(feature) {
  return feature.properties && feature.properties._selected_metric_value !== undefined && feature.properties._selected_metric_value !== null;
}

/** Rôle : Calcule une taille visuelle proportionnelle à une valeur numérique. */
function scaledSize(value, minSize, maxSize) {
  if (!currentMaxMetric || currentMaxMetric <= 0) return minSize;
  const ratio = Math.sqrt(Math.max(0, value) / currentMaxMetric);
  return minSize + ratio * (maxSize - minSize);
}

/** Rôle : Génère le contenu HTML de l'infobulle d'une entité. */
function popupContent(feature) {
  const props = feature.properties || {};
  const metricLabel = props._selected_metric_label || "Comptage";
  const metric = props._selected_metric_value ?? 0;
  const keys = Object.keys(props).filter(k => !String(k).startsWith("_") && !String(k).toLowerCase().includes("geo"));
  const displayedKeys = selectedPopupProperty ? [selectedPopupProperty] : keys.slice(0, 8);

  const mainMetric = hasCountMetric(feature) ? `
    <div class="popup-metric">${escapeHtml(metricLabel)} : <strong>${formatNumber(metric)}</strong></div>
  ` : "";

  const allCounts = props._selected_metric === "all" ? `
    <table class="popup-table popup-counts">
      <tr><td>Piétons</td><td>${formatNumber(props.pedestrian_count || 0)}</td></tr>
      <tr><td>Vélos</td><td>${formatNumber(props.bike_count || 0)}</td></tr>
      <tr><td>Voitures</td><td>${formatNumber(props.car_count || 0)}</td></tr>
      <tr><td>Poids lourds</td><td>${formatNumber(props.heavy_vehicle_count || 0)}</td></tr>
    </table>
  ` : "";

  const rows = displayedKeys
    .filter(key => key in props)
    .map(key => `<tr><td>${escapeHtml(key)}</td><td>${formatValue(props[key])}</td></tr>`)
    .join("");

  return `
    <div class="popup-title">Objet cartographique</div>
    ${mainMetric}
    ${allCounts}
    <table class="popup-table">${rows || "<tr><td>Aucun attribut</td></tr>"}</table>
  `;
}

/** Rôle : Crée le marqueur Leaflet correspondant à une entité ponctuelle. */
function pointToLayer(feature, latlng) {
  const radius = hasCountMetric(feature) ? scaledSize(metricValue(feature), 5, 18) : 6;
  const isGreen = isEspacesVertsDataset;
  const isParking = isParcsStationnementDataset;
  return L.circleMarker(latlng, {
    radius,
    weight: 2,
    color: isGreen ? "#15803d" : (isParking ? "#7c3aed" : "#1d4ed8"),
    fillColor: isGreen ? "#22c55e" : (isParking ? "#8b5cf6" : "#2563eb"),
    fillOpacity: 0.72
  });
}

/** Rôle : Détermine le style d'une géométrie linéaire ou surfacique. */
function styleGeometry(feature) {
  const type = feature.geometry?.type || "";
  const value = metricValue(feature);
  const hasMetric = hasCountMetric(feature);
  if (type.includes("Line")) {
    return {
      color: isEspacesVertsDataset ? "#15803d" : (isParcsStationnementDataset ? "#7c3aed" : "#dc2626"),
      weight: hasMetric ? scaledSize(value, 3, 12) : 4,
      opacity: 0.82
    };
  }
  if (type.includes("Polygon")) {
    return {
      color: isEspacesVertsDataset ? "#166534" : (isParcsStationnementDataset ? "#6d28d9" : "#dc2626"),
      weight: hasMetric ? scaledSize(value, 2, 8) : 3,
      fillColor: isEspacesVertsDataset ? "#22c55e" : (isParcsStationnementDataset ? "#8b5cf6" : "#f97316"),
      fillOpacity: isEspacesVertsDataset ? 0.35 : (isParcsStationnementDataset ? 0.32 : 0.25)
    };
  }
  return {
    color: "#1d4ed8",
    weight: 2,
    fillColor: "#2563eb",
    fillOpacity: 0.35
  };
}

/** Rôle : Affiche les entités filtrées dans une couche GeoJSON Leaflet. */
function renderLayer({ fitToData = true } = {}) {
  if (dataLayer) map.removeLayer(dataLayer);

  dataLayer = L.geoJSON(geojsonData, {
    pointToLayer,
    style: styleGeometry,
    onEachFeature: (feature, layer) => layer.bindPopup(popupContent(feature))
  }).addTo(map);

  if (fitToData && dataLayer.getBounds && geojsonData.features.length > 0) {
    const bounds = dataLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
  }
}


/** Rôle : Retire de la carte le contour de la zone recherchée. */
function removeNamedZoneLayer() {
  if (namedZoneLayer) {
    map.removeLayer(namedZoneLayer);
    namedZoneLayer = null;
  }
}

/** Rôle : Dessine sur la carte le contour de la zone géographique choisie. */
function drawNamedZone(zone) {
  removeNamedZoneLayer();

  if (zone.geometry) {
    namedZoneLayer = L.geoJSON(
      {
        type: "Feature",
        properties: { name: zone.display_name },
        geometry: zone.geometry
      },
      {
        style: {
          color: "#7c3aed",
          weight: 3,
          fillColor: "#8b5cf6",
          fillOpacity: 0.08,
          dashArray: "7 5"
        }
      }
    ).addTo(map);
  } else {
    const bbox = zone.bbox;
    namedZoneLayer = L.rectangle(
      [[bbox.south, bbox.west], [bbox.north, bbox.east]],
      {
        color: "#7c3aed",
        weight: 3,
        fillColor: "#8b5cf6",
        fillOpacity: 0.06,
        dashArray: "7 5"
      }
    ).addTo(map);
  }
}

/** Rôle : Calcule l'emprise Leaflet correspondant à une zone géographique. */
function geometryBoundsFromZone(zone) {
  if (zone.geometry) {
    const layer = L.geoJSON({
      type: "Feature",
      properties: {},
      geometry: zone.geometry
    });
    const bounds = layer.getBounds();
    if (bounds.isValid()) return bounds;
  }

  const bbox = zone.bbox;
  return L.latLngBounds(
    [bbox.south, bbox.west],
    [bbox.north, bbox.east]
  );
}

/** Rôle : Teste si un point appartient à un anneau polygonal. */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);

    const intersects =
      ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);

    if (intersects) inside = !inside;
  }
  return inside;
}

/** Rôle : Teste si un point appartient aux coordonnées d'un polygone. */
function pointInPolygonCoordinates(lng, lat, polygonCoordinates) {
  if (!Array.isArray(polygonCoordinates) || !polygonCoordinates.length) return false;
  if (!pointInRing(lng, lat, polygonCoordinates[0])) return false;

  // Un point situé dans un trou du polygone est exclu.
  for (let i = 1; i < polygonCoordinates.length; i += 1) {
    if (pointInRing(lng, lat, polygonCoordinates[i])) return false;
  }
  return true;
}

/** Rôle : Teste si un point est inclus dans une zone Polygon ou MultiPolygon. */
function pointInsideZone(lng, lat, zoneGeometry) {
  if (!zoneGeometry) return false;

  if (zoneGeometry.type === "Polygon") {
    return pointInPolygonCoordinates(lng, lat, zoneGeometry.coordinates);
  }

  if (zoneGeometry.type === "MultiPolygon") {
    return zoneGeometry.coordinates.some(polygon =>
      pointInPolygonCoordinates(lng, lat, polygon)
    );
  }

  return false;
}

/** Rôle : Vérifie si une entité intersecte la zone géographique recherchée. */
function featureIntersectsNamedZone(feature, zone, zoneBounds) {
  const geometry = feature?.geometry;
  if (!geometry) return false;

  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const [lng, lat] = geometry.coordinates.map(Number);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;

    if (zone.geometry && ["Polygon", "MultiPolygon"].includes(zone.geometry.type)) {
      return pointInsideZone(lng, lat, zone.geometry);
    }
    return zoneBounds.contains([lat, lng]);
  }

  if (geometry.type === "MultiPoint" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.some(coordinates => {
      const [lng, lat] = coordinates.map(Number);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
      if (zone.geometry && ["Polygon", "MultiPolygon"].includes(zone.geometry.type)) {
        return pointInsideZone(lng, lat, zone.geometry);
      }
      return zoneBounds.contains([lat, lng]);
    });
  }

  // Pour les lignes et polygones, Leaflet fournit une intersection fiable
  // avec l'emprise de la zone. Cela évite d'exclure un objet qui traverse
  // la commune même si aucun de ses sommets n'est strictement à l'intérieur.
  return featureIntersectsBounds(feature, zoneBounds);
}

/** Rôle : Recherche une zone nommée et propose les correspondances géographiques. */
async function searchNamedZone() {
  const query = namedZoneInput?.value.trim() || "";
  if (query.length < 2) {
    setStatus("Saisis au moins deux caractères pour rechercher une zone.", "error");
    return;
  }

  searchNamedZoneBtn.disabled = true;
  searchNamedZoneBtn.textContent = "Recherche…";

  try {
    const response = await fetch(`/api/zone-search?q=${encodeURIComponent(query)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.details || "Recherche impossible.");
    }

    namedZoneResultsData = Array.isArray(data.results) ? data.results : [];
    namedZoneResults.innerHTML = "";

    if (!namedZoneResultsData.length) {
      namedZoneResultsWrap.classList.add("hidden");
      setStatus(`Aucune zone trouvée pour « ${query} ».`, "error");
      return;
    }

    namedZoneResultsData.forEach((zone, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = zone.display_name;
      namedZoneResults.appendChild(option);
    });

    namedZoneResultsWrap.classList.remove("hidden");
    setStatus(
      `${namedZoneResultsData.length} résultat(s) trouvé(s). Choisis la zone puis applique le filtre.`,
      "ok"
    );
  } catch (error) {
    console.error(error);
    setStatus(`Erreur de recherche de zone : ${error.message}`, "error");
  } finally {
    searchNamedZoneBtn.disabled = false;
    searchNamedZoneBtn.textContent = "Rechercher";
  }
}

/** Rôle : Filtre les entités selon la zone nommée sélectionnée. */
function applyNamedZone() {
  if (!fullGeojsonData || !Array.isArray(fullGeojsonData.features)) {
    setStatus("Les données doivent être chargées avant d’appliquer une zone.", "error");
    return;
  }

  const index = Number(namedZoneResults.value);
  const zone = namedZoneResultsData[index];
  if (!zone) {
    setStatus("Sélectionne d’abord une zone dans les résultats.", "error");
    return;
  }

  const zoneBounds = geometryBoundsFromZone(zone);
  activeNamedZone = zone;
  activeSpatialBounds = zoneBounds;

  drawNamedZone(zone);
  map.fitBounds(zoneBounds, { padding: [25, 25] });

  const filteredFeatures = fullGeojsonData.features.filter(feature =>
    featureIntersectsNamedZone(feature, zone, zoneBounds)
  );

  geojsonData = {
    ...fullGeojsonData,
    features: filteredFeatures
  };

  featureCountEl.textContent = filteredFeatures.length;
  buildPropertyFilter(filteredFeatures);

  if (filteredFeatures.length) {
    renderLayer({ fitToData: false });
    setStatus(
      `Zone « ${zone.display_name} » appliquée : ${filteredFeatures.length} objet(s) affiché(s) ` +
      `sur ${fullGeojsonData.features.length}.`,
      "ok"
    );
  } else {
    if (dataLayer) {
      map.removeLayer(dataLayer);
      dataLayer = null;
    }
    setStatus(
      `Aucun objet du dataset ne se trouve dans la zone « ${zone.display_name} ».`,
      "error"
    );
  }

  if (resetSpatialFilterBtn) resetSpatialFilterBtn.disabled = false;
  if (spatialFilterStatus) {
    spatialFilterStatus.textContent =
      `${formatNumber(filteredFeatures.length)} objet(s) conservé(s) sur ` +
      `${formatNumber(fullGeojsonData.features.length)} — zone : ${zone.display_name}.`;
  }
}

/** Rôle : Vérifie si une entité intersecte l'emprise visible de la carte. */
function featureIntersectsBounds(feature, bounds) {
  try {
    const temporaryLayer = L.geoJSON(feature);
    const featureBounds = temporaryLayer.getBounds();
    return featureBounds.isValid() && bounds.intersects(featureBounds);
  } catch (error) {
    console.warn("Géométrie ignorée pendant le filtre spatial :", error);
    return false;
  }
}

/** Rôle : Actualise le nombre d'entités conservées par le filtre spatial. */
function updateSpatialFilterStatus(displayedCount, totalCount) {
  if (!spatialFilterStatus) return;

  if (!activeSpatialBounds) {
    spatialFilterStatus.textContent = `Aucune limite spatiale appliquée — ${formatNumber(totalCount)} objet(s) disponible(s).`;
    return;
  }

  const southWest = activeSpatialBounds.getSouthWest();
  const northEast = activeSpatialBounds.getNorthEast();
  spatialFilterStatus.textContent =
    `${formatNumber(displayedCount)} objet(s) conservé(s) sur ${formatNumber(totalCount)}. ` +
    `Emprise : ${southWest.lat.toFixed(4)}, ${southWest.lng.toFixed(4)} → ` +
    `${northEast.lat.toFixed(4)}, ${northEast.lng.toFixed(4)}.`;
}

/** Rôle : Limite les données à l'emprise actuellement visible sur la carte. */
function applyVisibleMapBounds() {
  if (!fullGeojsonData || !Array.isArray(fullGeojsonData.features)) {
    setStatus("Les données doivent être chargées avant d’appliquer une limite spatiale.", "error");
    return;
  }

  activeNamedZone = null;
  removeNamedZoneLayer();
  activeSpatialBounds = map.getBounds();
  const filteredFeatures = fullGeojsonData.features.filter(feature =>
    featureIntersectsBounds(feature, activeSpatialBounds)
  );

  geojsonData = {
    ...fullGeojsonData,
    features: filteredFeatures
  };

  featureCountEl.textContent = filteredFeatures.length;
  buildPropertyFilter(filteredFeatures);

  if (filteredFeatures.length) {
    renderLayer({ fitToData: false });
    setStatus(
      `Filtre spatial appliqué : ${filteredFeatures.length} objet(s) affiché(s) ` +
      `sur ${fullGeojsonData.features.length}.`,
      "ok"
    );
  } else {
    if (dataLayer) {
      map.removeLayer(dataLayer);
      dataLayer = null;
    }
    setStatus("Aucun objet du dataset ne se trouve dans la zone visible sélectionnée.", "error");
  }

  if (resetSpatialFilterBtn) resetSpatialFilterBtn.disabled = false;
  updateSpatialFilterStatus(filteredFeatures.length, fullGeojsonData.features.length);
}

/** Rôle : Supprime le filtre spatial et restaure toutes les entités. */
function resetSpatialFilter() {
  if (!fullGeojsonData) return;

  activeSpatialBounds = null;
  activeNamedZone = null;
  removeNamedZoneLayer();
  geojsonData = fullGeojsonData;
  featureCountEl.textContent = fullGeojsonData.features?.length || 0;
  buildPropertyFilter(fullGeojsonData.features || []);
  renderLayer({ fitToData: true });

  if (resetSpatialFilterBtn) resetSpatialFilterBtn.disabled = true;
  updateSpatialFilterStatus(fullGeojsonData.features?.length || 0, fullGeojsonData.features?.length || 0);
  setStatus(`Zone réinitialisée : tous les ${fullGeojsonData.features?.length || 0} objet(s) sont affichés.`, "ok");
}

/** Rôle : Construit les contrôles permettant de filtrer les entités par attribut. */
function buildPropertyFilter(features) {
  const previous = propertyFilter.value;
  propertyFilter.innerHTML = '<option value="">Tous les attributs principaux</option>';

  const keys = new Set();
  features.forEach(feature => {
    Object.keys(feature.properties || {}).forEach(key => {
      if (!String(key).startsWith("_") && !String(key).toLowerCase().includes("geo")) keys.add(key);
    });
  });

  [...keys].sort().forEach(key => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    propertyFilter.appendChild(option);
  });

  if ([...propertyFilter.options].some(option => option.value === previous)) {
    propertyFilter.value = previous;
  } else {
    selectedPopupProperty = "";
  }
}

propertyFilter.addEventListener("change", () => {
  selectedPopupProperty = propertyFilter.value;
  if (geojsonData) renderLayer({ fitToData: false });
});

if (searchNamedZoneBtn) {
  searchNamedZoneBtn.addEventListener("click", searchNamedZone);
}

if (namedZoneInput) {
  namedZoneInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchNamedZone();
    }
  });
}

if (applyNamedZoneBtn) {
  applyNamedZoneBtn.addEventListener("click", applyNamedZone);
}

if (applyMapBoundsBtn) {
  applyMapBoundsBtn.addEventListener("click", applyVisibleMapBounds);
}

if (resetSpatialFilterBtn) {
  resetSpatialFilterBtn.addEventListener("click", resetSpatialFilter);
}

reloadBtn.addEventListener("click", () => loadDataset());
dateInput.addEventListener("change", () => loadDataset());
hourInput.addEventListener("change", () => loadDataset());
metricInput.addEventListener("change", () => loadDataset());

if (isStaticDataset) {
  if (temporalControls) temporalControls.classList.add("hidden");
  if (metricLine) metricLine.classList.add("hidden");

  if (isZonesRencontreDataset) {
    if (statsHelp) statsHelp.textContent = "Pour ce dataset statique, le total correspond au nombre de zones/sections chargées depuis le GeoJSON local.";
    if (legendHelp) legendHelp.textContent = "Les zones de rencontre sont affichées selon leur géométrie GeoJSON, principalement des lignes/multilignes.";
  } else if (isEspacesVertsDataset) {
    if (statsHelp) statsHelp.textContent = "Pour ce dataset statique, le total correspond au nombre d’espaces verts chargés depuis le GeoJSON local.";
    if (legendHelp) legendHelp.textContent = "Les espaces verts sont affichés sous forme de polygones/multipolygones issus du fichier GeoJSON.";
  } else if (isVelotoulouseDataset) {
    if (statsHelp) statsHelp.textContent = "Pour VélÔToulouse, Flask récupère automatiquement toutes les pages de l’API avec limit + offset.";
    if (legendHelp) legendHelp.textContent = "Chaque point représente une station VélÔToulouse localisée par l’API Open Data Toulouse Métropole.";
  } else if (isParcsStationnementDataset) {
    if (statsHelp) statsHelp.textContent = "Pour les parcs de stationnement, Flask récupère automatiquement toutes les pages de l’API avec limit + offset.";
    if (legendHelp) legendHelp.textContent = "Chaque point ou géométrie représente un parc de stationnement issu de l’API Open Data Toulouse Métropole.";
  } else {
    if (statsHelp) statsHelp.textContent = "Flask construit automatiquement l’URL de l’API OpenDataSoft à partir de l’identifiant du dataset et récupère les pages disponibles.";
    if (legendHelp) legendHelp.textContent = "La carte affiche automatiquement les GeoPoint, GeoShape, géométries GeoJSON ou couples latitude/longitude détectés.";
  }
}

/** Rôle : Récupère le jeu demandé auprès du serveur et initialise sa visualisation. */
async function loadDataset() {
  try {
    const loadingMessage = (isZonesRencontreDataset || isEspacesVertsDataset)
      ? "Chargement du GeoJSON local via Flask..."
      : "Appel de l’API via Flask avec pagination automatique...";
    setStatus(loadingMessage);
    reloadBtn.disabled = true;

    const params = new URLSearchParams();
    params.set("title", datasetTitle);
    if (isTemporalCountsDataset) {
      params.set("date", dateInput.value || "2025-01-01");
      params.set("hour", hourInput.value || "1");
      params.set("metric", metricInput.value || "all");
    }

    const queryString = params.toString();
    const response = await fetch(`/api/dataset/${encodeURIComponent(datasetId)}${queryString ? `?${queryString}` : ""}`);
    const data = await response.json();
    if (!response.ok) {
      const message = [data.error, data.details].filter(Boolean).join(" ") || "Erreur inconnue";
      throw new Error(message);
    }

    fullGeojsonData = data;
    geojsonData = data;
    activeSpatialBounds = null;
    activeNamedZone = null;
    removeNamedZoneLayer();
    if (resetSpatialFilterBtn) resetSpatialFilterBtn.disabled = true;
    const count = data.features ? data.features.length : 0;
    updateSpatialFilterStatus(count, count);
    currentMaxMetric = Number(data.computed?.metric_max || 1);
    featureCountEl.textContent = count;
    apiTotalEl.textContent = data.metadata?.total_api ?? "Non renseigné";
    metricTotalEl.textContent = data.computed?.metric_total === null || data.computed?.metric_total === undefined ? "Non applicable" : formatNumber(data.computed?.metric_total || 0);
    if (isStaticDataset) {
      periodLabelEl.textContent = "Dataset statique — sans filtre temporel";
    } else {
      periodLabelEl.textContent = `${data.metadata?.date || dateInput.value} — ${String(data.metadata?.hour ?? hourInput.value).padStart(2, "0")}:00 à ${String(((Number(data.metadata?.hour ?? hourInput.value) + 1) % 24)).padStart(2, "0")}:00`;
    }

    if (!count) {
      if (dataLayer) map.removeLayer(dataLayer);
      buildPropertyFilter([]);
      const emptyMessage = isTemporalCountsDataset
        ? "Données reçues, mais aucune géométrie exploitable n’a été détectée pour cette heure."
        : "Données reçues, mais aucune géométrie exploitable n’a été détectée pour ce dataset.";
      setStatus(emptyMessage, "error");
      return;
    }

    buildPropertyFilter(data.features);
    renderLayer({ fitToData: true });
    const geometryText = data.metadata?.geometry_types ? ` Géométrie : ${data.metadata.geometry_types.join(", ")}.` : "";
    const truncationText = data.metadata?.truncated ? ` Chargement limité aux ${data.metadata?.max_records} premiers enregistrements pour protéger l’application.` : "";
    setStatus(`Données chargées : ${count} objet(s) cartographique(s) affiché(s), ${data.metadata?.records_loaded ?? count} enregistrement(s) récupéré(s) sur ${data.metadata?.total_api ?? "un total non renseigné"}.${geometryText}${truncationText}`, "ok");
  } catch (error) {
    console.error(error);
    setStatus(`Erreur : ${error.message}`, "error");
  } finally {
    reloadBtn.disabled = false;
  }
}

loadDataset();
