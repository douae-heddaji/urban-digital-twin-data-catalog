"""
Capture périodique de l'historique des datasets dynamiques.

Ce script est indépendant du serveur Flask : on le lance via le
Planificateur de tâches (Windows) ou cron (Linux/Mac), à intervalle régulier.
Il continue de capturer même si l'application Flask n'est pas ouverte dans
un navigateur — tant que le serveur `app.py` tourne quelque part (localement
ou sur un vrai serveur), la capture peut avoir lieu.

Ce qu'il fait à chaque exécution :
  1. Récupère la liste des datasets depuis le Google Sheet (même source que
     le catalogue), et ne garde que ceux marqués "Dynamique".
  2. Pour chacun, appelle l'API Flask déjà existante (/api/dataset/<id>) —
     ça réutilise toute la logique de récupération/jointure déjà en place,
     sans avoir à la dupliquer ici.
  3. Ajoute à chaque enregistrement la date et l'heure de capture
     (_capture_date / _capture_heure) — c'est le système qui les assigne à
     ce moment précis, jamais une valeur lue dans les données elles-mêmes.
     Ça permet d'historiser même un dataset qui n'a lui-même aucun attribut
     de date.
  4. Enregistre l'instantané dans une base SQLite locale (history.db),
     seulement s'il diffère du dernier instantané connu pour ce dataset
     (pour éviter de multiplier les copies identiques).

Usage :
    python capture.py

Configuration : modifie les constantes ci-dessous si besoin (adresse du
serveur Flask, URL Apps Script...).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

# --- Configuration ---------------------------------------------------------

APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzHJJUeJXdHcTOiDyAtBnZ1eQsyR4IgWpbW2mFK_9Vv7WtG9_tStrYhCRQ2reJy9hlMYA/exec"
GOOGLE_SHEET_ID = "1hlZBcHTi2NvcqdmKnrUqhuyJnW_ls0TUOxNPkHEl6dc"

# Adresse du serveur Flask. Si l'app tourne ailleurs (autre machine, autre
# port), change cette valeur.
FLASK_BASE_URL = "http://127.0.0.1:5000"

DB_PATH = Path(__file__).resolve().parent / "history.db"

REQUEST_TIMEOUT_CATALOG = 30
REQUEST_TIMEOUT_DATASET = 150


# --- Base de données --------------------------------------------------------

def init_db() -> sqlite3.Connection:
    """Crée les tables nécessaires à l'historisation si elles n'existent pas encore."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dataset_id TEXT NOT NULL,
            dataset_title TEXT,
            captured_at TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            payload TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_snapshots_dataset_time ON snapshots(dataset_id, captured_at)"
    )
    conn.commit()
    return conn


# --- Récupération de la liste des datasets dynamiques -----------------------

def extract_ods_dataset_id(url: str) -> str | None:
    """Extrait ods dataset id."""
    if not url:
        return None
    match = re.search(r"/explore/dataset/([^/?#]+)", url, re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(r"/catalog/datasets/([^/?#]+)", url, re.IGNORECASE)
    if match:
        return match.group(1)
    return None


def fetch_dynamic_datasets() -> list[dict]:
    """Récupère dynamic datasets."""
    response = requests.get(
        APPS_SCRIPT_URL, params={"sheetId": GOOGLE_SHEET_ID}, timeout=REQUEST_TIMEOUT_CATALOG
    )
    response.raise_for_status()
    payload = response.json()
    all_datasets = payload.get("datasets", [])

    dynamic = []
    for entry in all_datasets:
        if str(entry.get("nature", "")).strip().lower() != "dynamique":
            continue
        dataset_id = extract_ods_dataset_id(entry.get("url"))
        if not dataset_id:
            print(f"  [ignoré] « {entry.get('title')} » : identifiant introuvable dans l'URL ({entry.get('url')!r})")
            continue
        dynamic.append({"id": dataset_id, "title": entry.get("title") or dataset_id})
    return dynamic


# --- Capture d'un dataset ----------------------------------------------------

def resolve_capture_date(dataset_id: str) -> str | None:
    """Find which date to request for this dataset. Prefers its own most
    recent available date (via the already-validated temporal-range
    endpoint) — not just "today", since a dataset's real, current data isn't
    necessarily dated today. Returns None if the dataset has no temporal
    field at all (then no date filter is applied — fine for small,
    non-historical datasets like station counts)."""
    try:
        response = requests.get(
            f"{FLASK_BASE_URL}/api/dataset-temporal-range/{dataset_id}", timeout=REQUEST_TIMEOUT_DATASET
        )
    except requests.RequestException:
        return None
    if not response.ok:
        return None
    info = response.json()
    if info.get("temporal_available") and info.get("max_date"):
        return info["max_date"]
    return None


def fetch_dataset_geojson(dataset_id: str, title: str) -> dict:
    # Aucune date n'est précisée volontairement : le mécanisme générique
    # "pas de date choisie" de l'application (tri + dédoublonnage par entité,
    # pages récupérées en parallèle) donne déjà directement le relevé le plus
    # récent par entité, que le dataset en ait une seule (ex. une station
    # météo) ou plusieurs (ex. VélÔToulouse, tout un réseau de stations) —
    # rapide et correct dans les deux cas depuis les derniers correctifs.
    # Préciser une date forcerait "toutes les lignes de ce jour", ce qui pour
    # un flux à mise à jour fréquente (VélÔToulouse Disponibilité) renvoyait
    # tous les relevés de la journée par station au lieu d'un instantané.
    """Récupère dataset geojson."""
    params = {"title": title}
    response = requests.get(
        f"{FLASK_BASE_URL}/api/dataset/{dataset_id}",
        params=params,
        timeout=REQUEST_TIMEOUT_DATASET,
    )
    if response.status_code == 422:
        # Ce dataset n'a probablement aucune géométrie propre (ex. VélÔToulouse
        # "Disponibilité temps réel", qui doit être croisé avec le dataset de
        # localisation des stations pour avoir des coordonnées). On résout
        # automatiquement le meilleur référentiel de jointure, comme le fait
        # déjà le bouton "Visualiser directement" côté carte.
        return fetch_via_auto_join(dataset_id, title)
    response.raise_for_status()
    return response.json()


def fetch_via_auto_join(dataset_id: str, title: str) -> dict:
    """Récupère via auto join."""
    diagnostic_response = requests.get(
        f"{FLASK_BASE_URL}/api/spatial-diagnostic/{dataset_id}",
        params={"title": title},
        timeout=REQUEST_TIMEOUT_DATASET,
    )
    diagnostic_response.raise_for_status()
    candidates = diagnostic_response.json().get("join_candidates", [])
    best = next((c for c in candidates if c.get("verified_by_values")), None)
    if not best:
        raise RuntimeError(
            "aucune géométrie propre et aucune jointure automatique fiable trouvée"
        )
    params = {
        "title": title,
        "source_title": title,
        "reference_title": best.get("title", best["dataset_id"]),
        "source_field": best.get("source_field", ""),
        "target_field": best.get("target_field", ""),
        # Pas de date ici non plus : le mécanisme générique "pas de date" de
        # /api/join-reference donne déjà un instantané par entité, y compris
        # pour un flux multi-stations à mise à jour fréquente.
    }
    join_response = requests.get(
        f"{FLASK_BASE_URL}/api/join-reference/{dataset_id}/{best['dataset_id']}",
        params=params,
        timeout=REQUEST_TIMEOUT_DATASET,
    )
    join_response.raise_for_status()
    result = join_response.json()
    meta = result.get("metadata", {})
    print(
        f"    [diagnostic jointure] source: {meta.get('source_records_loaded', '?')} chargés / "
        f"{meta.get('source_records_matched', '?')} appariés · référentiel retenu: "
        f"{meta.get('reference_records_matched', '?')} · features: {len(result.get('features', []))}"
    )
    return result


def stamp_capture_time(geojson: dict, captured_at: datetime) -> dict:
    """Ajoute la date/heure de capture à chaque enregistrement — y compris
    pour les datasets qui n'ont eux-mêmes aucun attribut temporel."""
    date_str = captured_at.strftime("%Y-%m-%d")
    time_str = captured_at.strftime("%H:%M")
    for feature in geojson.get("features", []):
        properties = feature.setdefault("properties", {})
        properties["_capture_date"] = date_str
        properties["_capture_heure"] = time_str
    return geojson


def content_hash(geojson: dict) -> str:
    """Assure le traitement associé à « content hash »."""
    canonical = json.dumps(geojson, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def already_captured(conn: sqlite3.Connection, dataset_id: str, new_hash: str) -> bool:
    """Assure le traitement associé à « already captured »."""
    row = conn.execute(
        "SELECT content_hash FROM snapshots WHERE dataset_id = ? ORDER BY captured_at DESC LIMIT 1",
        (dataset_id,),
    ).fetchone()
    return row is not None and row[0] == new_hash


# --- Point d'entrée -----------------------------------------------------------

def run() -> dict:
    """Assure le traitement associé à « run »."""
    captured_at = datetime.now()
    print(f"=== Capture démarrée : {captured_at.isoformat(timespec='seconds')} ===")

    summary = {
        "captured_at": captured_at.isoformat(timespec="seconds"),
        "dynamic_count": 0,
        "captured_count": 0,
        "unchanged_count": 0,
        "errors": [],  # liste de {"title": ..., "dataset_id": ..., "error": ...}
    }

    conn = init_db()
    try:
        dynamic_datasets = fetch_dynamic_datasets()
    except Exception as exc:
        print(f"Impossible de récupérer la liste des datasets dynamiques : {exc}")
        conn.close()
        summary["errors"].append({"title": None, "dataset_id": None, "error": str(exc)})
        return summary

    summary["dynamic_count"] = len(dynamic_datasets)
    print(f"{len(dynamic_datasets)} dataset(s) dynamique(s) détecté(s).")

    for dataset in dynamic_datasets:
        dataset_id, title = dataset["id"], dataset["title"]
        geojson = None
        last_exc: Exception | None = None
        # Une seule tentative supplémentaire : suffisant pour absorber un aléa
        # ponctuel de l'API source (ex. un léger accroc sur un dataset très
        # volatile comme VélÔToulouse Disponibilité), sans faire traîner la
        # capture entière si le problème est en fait persistant.
        for attempt in range(2):
            try:
                geojson = fetch_dataset_geojson(dataset_id, title)
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                if attempt == 0:
                    time.sleep(3)
        if last_exc is not None:
            print(f"  [erreur] {title} ({dataset_id}) : {last_exc}")
            summary["errors"].append({"title": title, "dataset_id": dataset_id, "error": str(last_exc)})
            continue

        # Important : le hash de déduplication se calcule uniquement sur les
        # "features" (les vraies données), jamais sur la réponse complète —
        # les métadonnées techniques qui l'accompagnent (temps de traitement,
        # url interrogée, compteurs de pages...) peuvent légèrement varier
        # d'un appel à l'autre même quand les données affichées sont
        # identiques (surtout pour un dataset qui passe par une jointure),
        # ce qui ferait échouer la détection "inchangé" à tort. On calcule
        # aussi le hash AVANT tout tamponnage de l'heure de capture — sinon
        # il changerait à chaque exécution même si rien n'a réellement
        # changé, et on insérerait une nouvelle ligne à l'infini.
        new_hash = content_hash(geojson.get("features", []))

        if already_captured(conn, dataset_id, new_hash):
            print(f"  [inchangé] {title} — pas de nouvelle capture enregistrée.")
            summary["unchanged_count"] += 1
            continue

        geojson = stamp_capture_time(geojson, captured_at)

        conn.execute(
            "INSERT INTO snapshots (dataset_id, dataset_title, captured_at, content_hash, payload) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                dataset_id,
                title,
                captured_at.isoformat(timespec="seconds"),
                new_hash,
                json.dumps(geojson, ensure_ascii=False),
            ),
        )
        conn.commit()
        summary["captured_count"] += 1
        print(f"  [capturé] {title} — {len(geojson.get('features', []))} enregistrement(s).")

    conn.close()
    print(f"=== Capture terminée : {summary['captured_count']} nouveau(x) instantané(s) enregistré(s). ===")
    return summary


if __name__ == "__main__":
    result = run()
    if result["dynamic_count"] == 0 and result["errors"]:
        sys.exit(1)
