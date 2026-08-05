const card = document.getElementById("diagnosticCard");
const id = window.SPATIAL_DATASET_ID;
const title = window.SPATIAL_DATASET_TITLE;

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[char]));

/** Rôle : Convertit un score décimal en pourcentage lisible. */
function percent(value) {
  return value === null || value === undefined
    ? "Non vérifié"
    : `${Math.round(Number(value) * 100)} %`;
}

/** Rôle : Affiche les clés de jointure détectées pour le jeu analysé. */
function renderJoinKeys(data) {
  return (data.join_keys || []).map(key => `
    <div class="key-card">
      <strong>Clé détectée : ${esc(key.field)}</strong>
      <p>
        Famille : ${esc(key.family)} · valeurs renseignées : ${key.filled}
        · valeurs distinctes : ${key.distinct}
        · unicité : ${Math.round((key.uniqueness_ratio || 0) * 100)} %
      </p>
      <p class="examples">Exemples : ${(key.examples || []).map(esc).join(", ") || "Non disponible"}</p>
      ${(key.suggestions || []).map(suggestion => `
        <p><b>${esc(suggestion.label)}</b><br>${esc(suggestion.hint)}</p>
      `).join("")}
    </div>
  `).join("");
}

let selectedCandidateId = null;

/** Rôle : Affiche et classe les référentiels candidats proposés par le diagnostic. */
function renderCandidates(data) {
  const candidates = data.join_candidates || [];
  if (!candidates.length) return "";

  return `
    <section class="candidate-section">
      <h3>Référentiels géographiques candidats</h3>
      <p class="muted">
        Choisis le référentiel géographique avec lequel croiser ce dataset. Clique sur une carte pour la sélectionner :
        seul le référentiel choisi peut ensuite être utilisé pour visualiser le croisement.
      </p>
      <div class="candidate-list">
        ${candidates.map(candidate => {
          const isSelectable = Boolean(candidate.verified_by_values);
          const isSelected = isSelectable && candidate.dataset_id === selectedCandidateId;
          return `
          <article class="candidate-card ${isSelected ? "candidate-selected" : ""} ${isSelectable ? "candidate-selectable" : "candidate-disabled"}" ${isSelectable ? `data-candidate-id="${esc(candidate.dataset_id)}" role="button" tabindex="0"` : ""}>
            <div class="candidate-heading">
              <div>
                ${isSelected ? '<span class="best-badge">Référentiel sélectionné</span>' : ''}
                <h4>${esc(candidate.title)}</h4>
                <p class="muted">${esc(candidate.theme || "Thématique non renseignée")}</p>
              </div>
              <span class="confidence ${esc(candidate.confidence)}">
                ${esc(candidate.confidence)} · ${esc(candidate.score)} / 100
              </span>
            </div>

            ${candidate.verified_by_values ? `
              <dl class="candidate-details">
                <div><dt>Clé du dataset analysé</dt><dd>${esc(candidate.source_field)}</dd></div>
                <div><dt>Clé du référentiel</dt><dd>${esc(candidate.target_field)}</dd></div>
                <div><dt>Valeurs source retrouvées</dt><dd>${percent(candidate.source_coverage)}</dd></div>
                <div><dt>Unicité côté référentiel</dt><dd>${percent(candidate.target_uniqueness)}</dd></div>
              </dl>
              <p class="examples">
                Valeurs communes : ${(candidate.common_examples || []).map(esc).join(", ") || "Non disponible"}
              </p>
            ` : `
              <p class="candidate-warning">
                Candidat repéré par proximité métier, mais aucune paire de clés n’a encore été confirmée par les valeurs : jointure non proposée.
              </p>
            `}

            ${isSelected ? `
              <div class="candidate-actions">
                <a class="action-link" href="/carte?dataset=${encodeURIComponent(id)}&title=${encodeURIComponent(title)}&reference_target=${encodeURIComponent(candidate.dataset_id)}&reference_title=${encodeURIComponent(candidate.title)}&source_title=${encodeURIComponent(title)}&source_field=${encodeURIComponent(candidate.source_field || "")}&target_field=${encodeURIComponent(candidate.target_field || "")}">
                  📍 Visualiser le croisement de données
                </a>
              </div>
            ` : (isSelectable ? '<p class="candidate-note">Clique sur cette carte pour choisir ce référentiel.</p>' : '')}
          </article>
        `}).join("")}
      </div>
    </section>
  `;
}

/** Rôle : Associe les actions de sélection aux candidats de jointure affichés. */
function bindCandidateSelection(data) {
  document.querySelectorAll(".candidate-card.candidate-selectable").forEach(el => {
    const select = () => {
      selectedCandidateId = el.dataset.candidateId;
      render(data);
    };
    el.addEventListener("click", select);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } });
  });
}

/** Rôle : Construit l'affichage complet du diagnostic spatial reçu du serveur. */
function render(data) {
  const keys = renderJoinKeys(data);
  const candidates = renderCandidates(data);
  const addresses = (data.address_fields || []).length
    ? `<div class="info"><b>Champs d’adresse</b><p>${data.address_fields.map(esc).join(", ")}</p></div>`
    : "";
  const mapLink = data.status === "direct_geo"
    ? `<a class="action-link" href="/carte?dataset=${encodeURIComponent(id)}&title=${encodeURIComponent(title)}">🗺️ Ouvrir la carte</a>`
    : "";

  card.innerHTML = `
    <span class="status ${esc(data.status)}">${esc(data.status_label)}</span>
    <h2>${esc(data.title || title)}</h2>
    <p>${esc(data.message)}</p>

    <div class="grid-info">
      <div class="info"><b>Confiance</b><p>${esc(data.confidence || "Non renseignée")}</p></div>
      <div class="info"><b>Enregistrements analysés</b><p>${esc(data.records_sampled || 0)}</p></div>
      <div class="info"><b>Total API</b><p>${esc(data.total_api ?? "Non renseigné")}</p></div>
      ${addresses}
    </div>

    ${keys}
    ${candidates}

    <div class="actions">
      ${mapLink}
      <a class="action-link secondary" href="/">Retour au catalogue</a>
    </div>
  `;
  bindCandidateSelection(data);
}

fetch(`/api/spatial-diagnostic/${encodeURIComponent(id)}?title=${encodeURIComponent(title)}`)
  .then(async response => {
    const data = await response.json();
    if (!response.ok) {
      throw new Error([data.error, data.details].filter(Boolean).join(" "));
    }
    return data;
  })
  .then(render)
  .catch(error => {
    card.classList.add("error");
    card.innerHTML = `<h2>Diagnostic impossible</h2><p>${esc(error.message)}</p>`;
  });
