"""Sources de données locales (fichiers GPKG/GeoJSON/CSV dans data/) : Contours IRIS,
BD TOPO, Recensement Population — chargement, filtrage, cache disque."""
from __future__ import annotations

import json
import re
import time
import unicodedata
import io
import tempfile
import zipfile
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import requests
from flask import Flask, jsonify, render_template, request, send_from_directory, send_file

from connectors import DataGouvConnector, DataGouvConnectorError
from history import scheduler as history_scheduler


# BASE_DIR recalculé : ce fichier vit dans scripts/, la racine du projet
# (contenant data/, templates/, static/...) est donc le dossier PARENT de scripts/.
BASE_DIR = Path(__file__).resolve().parent.parent

from .open_data_api import *  # noqa: F401,F403


COMMUNE_CODE_COLUMN_CANDIDATES = ["code_insee", "insee_commune", "insee_com", "code_commune"]


def _commune_code_column(columns) -> Optional[str]:
    """Retourne le premier nom de colonne "code commune INSEE" présent parmi
    les variantes connues, ou None si aucune ne correspond."""
    columns_set = set(columns)
    for name in COMMUNE_CODE_COLUMN_CANDIDATES:
        if name in columns_set:
            return name
    return None

# 37 communes de Toulouse Métropole (codes INSEE) — utilisé pour filtrer les
# référentiels géographiques nationaux trop volumineux (ex. Contours IRIS).
TOULOUSE_METROPOLE_COMMUNES = [
    "31003", "31022", "31032", "31044", "31053", "31056", "31069", "31088",
    "31091", "31116", "31149", "31150", "31157", "31163", "31182", "31184",
    "31186", "31205", "31230", "31282", "31293", "31351", "31352", "31355",
    "31389", "31417", "31418", "31445", "31467", "31488", "31490", "31506",
    "31541", "31555", "31557", "31561", "31588",
]

# Plafond de sécurité pour les GPKG locaux volumineux (ex. BD TOPO "batiment") :
# même filtrée sur la Métropole, une couche dense peut rester trop lourde à
# sérialiser/afficher en une requête synchrone. Repris du script de PoC de
# l'utilisateur (limite similaire, échantillon déterministe).
MAX_LOCAL_GPKG_FEATURES = 30000

# Seuls les fichiers locaux doivent encore être déclarés explicitement.
LOCAL_DATASETS: Dict[str, Dict[str, str]] = {
    "zones-de-rencontre": {
        "title": "Zones de rencontre",
        "source_type": "local_geojson",
        "file": "zones-de-rencontre.geojson",
    },
    "espaces-verts": {
        "title": "Espaces verts",
        "source_type": "local_geojson",
        "file": "espaces-verts.geojson",
    },
    "recensement-population-2020": {
        "title": "Recensement Population 2020",
        "source_type": "local_csv",
        "file": "recensement_2020_toulouse_metropole.csv",
        "id_field": "iris",
    },
    "recensement-population-2021": {
        "title": "Recensement Population 2021",
        "source_type": "local_csv",
        "file": "recensement_2021_toulouse_metropole.csv",
        "id_field": "iris",
    },
    "recensement-population-2022": {
        "title": "Recensement Population 2022",
        "source_type": "local_csv",
        "file": "recensement_2022_toulouse_metropole.csv",
        "id_field": "iris",
    },
    "contours-iris": {
        "title": "Contours IRIS",
        "source_type": "local_gpkg",
        "file": "iris.gpkg",
        "id_field": "code_iris",
    },
    "bd-topo": {
        "title": "BD TOPO",
        "source_type": "local_gpkg",
        "file": "BDT_3-5_GPKG_LAMB93_D031-ED2025-12-15.gpkg",
        # Pas de "layer" fixe : ce GPKG contient plusieurs couches (bâtiments,
        # routes...) — la couche par défaut et la liste des couches disponibles
        # sont résolues dynamiquement dans _local_gpkg_to_response.
    },
}

# Les exceptions servent uniquement aux datasets dont l'affichage nécessite
# une logique particulière. Tous les autres datasets Open Data Toulouse sont
# traités automatiquement comme des datasets géographiques statiques.
DATASET_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "comptages-routiers-et-pietons-2025": {
        "title": "Comptages routiers et piétons 2025",
        "source_type": "api_temporal_counts",
        "date_field": "started_at",
    },
}


# Champs fréquemment utilisables pour relier un dataset non géographique à
# un référentiel contenant une géométrie. Les alias sont normalisés avant analyse.
def _get_dataset_config(dataset_id: str) -> Optional[Dict[str, Any]]:
    """Return a local, data.gouv.fr, exceptional, or OpenDataSoft config."""
    # BD TOPO contient plusieurs couches (bâtiments, routes...) : l'identifiant
    # composite "bd-topo::<couche>" sélectionne explicitement une couche, en
    # réutilisant le fichier déclaré dans LOCAL_DATASETS["bd-topo"].
    if dataset_id.startswith("bd-topo::"):
        layer = dataset_id.split("::", 1)[1]
        base = LOCAL_DATASETS.get("bd-topo", {})
        return {
            "title": f"BD TOPO — {layer.replace('_', ' ').strip().title()}",
            "source_type": "local_gpkg",
            "file": base.get("file", "BDT_3-5_GPKG_LAMB93_D031-ED2025-12-15.gpkg"),
            "layer": layer,
        }

    if dataset_id in LOCAL_DATASETS:
        return dict(LOCAL_DATASETS[dataset_id])

    if dataset_id.startswith(DATA_GOUV_PREFIX):
        identifier = DATA_GOUV_CONNECTOR.extract_dataset_identifier(dataset_id)
        if not identifier:
            return None
        return {
            "title": identifier.replace("-", " ").capitalize(),
            "source_type": "data_gouv_auto",
            "data_gouv_identifier": identifier,
        }

    if not _is_known_dataset_id_shape(dataset_id):
        return None

    _, slug = _parse_ods_dataset_id(dataset_id)
    override = dict(DATASET_OVERRIDES.get(dataset_id, {}))
    return {
        "title": override.pop("title", slug.replace("-", " ").capitalize()),
        "source_type": override.pop("source_type", "api_static_geo"),
        "base_url": _build_toulouse_records_url(dataset_id),
        **override,
    }


def _local_geojson_to_response(dataset_id: str, dataset: Dict[str, str]) -> Dict[str, Any]:
    """Load a local GeoJSON file and return it with catalogue-map metadata."""
    geojson_path = BASE_DIR / "data" / dataset["file"]
    with geojson_path.open("r", encoding="utf-8") as handle:
        geojson = json.load(handle)

    features = geojson.get("features") or []
    geometry_types = sorted({
        feature.get("geometry", {}).get("type", "Non renseigné")
        for feature in features
        if isinstance(feature, dict)
    })

    return {
        "type": "FeatureCollection",
        "features": features,
        "computed": {
            "metric": None,
            "metric_label": "Sans comptage",
            "metric_total": None,
            "metric_max": None,
        },
        "metadata": {
            "dataset": dataset_id,
            "title": dataset["title"],
            "source_type": "local_geojson",
            "source_file": dataset["file"],
            "features_displayed": len(features),
            "records_loaded": len(features),
            "total_api": len(features),
            "geometry_types": geometry_types,
        },
    }


def _peek_gpkg_columns(gpkg_path: Path, layer: Optional[str]) -> set[str]:
    """Read only the schema (field names) of a GPKG layer, sans charger les
    données — pour décider de la stratégie de filtrage sans payer le coût
    d'une lecture complète."""
    try:
        import fiona
        with fiona.open(str(gpkg_path), layer=layer) as source:
            return set((source.schema or {}).get("properties", {}).keys())
    except Exception:
        return set()


def _read_gpkg_layer_filtered(gpkg_path: Path, layer: Optional[str]):
    """Read a GPKG layer, en poussant le filtrage Toulouse Métropole au niveau
    du fichier (clause SQL WHERE si une colonne 'code_insee' existe, sinon une
    bbox large) plutôt que de tout charger en mémoire pour filtrer ensuite avec
    pandas — indispensable sur un fichier volumineux (ex. BD TOPO, plusieurs
    centaines de milliers d'entités pour un département entier).
    """
    import geopandas as gpd

    columns = _peek_gpkg_columns(gpkg_path, layer)
    read_kwargs: Dict[str, Any] = {}
    commune_column = _commune_code_column(columns)
    if commune_column:
        codes = ",".join(f"'{code}'" for code in TOULOUSE_METROPOLE_COMMUNES)
        read_kwargs["where"] = f"{commune_column} IN ({codes})"
    elif columns:
        # Pas de colonne commune exploitable (ex. tronçons hydrographiques,
        # lignes électriques...) : on limite quand même la zone lue avec une
        # bbox large autour de Toulouse Métropole, reprojetée automatiquement
        # dans le CRS source par geopandas.
        from shapely.geometry import box
        read_kwargs["bbox"] = gpd.GeoDataFrame(geometry=[box(1.15, 43.35, 1.75, 43.85)], crs="EPSG:4326")

    try:
        return gpd.read_file(gpkg_path, layer=layer, **read_kwargs) if layer else gpd.read_file(gpkg_path, **read_kwargs)
    except Exception:
        # Repli : le moteur GDAL utilisé ne supporte pas where/bbox pour ce
        # fichier — lecture complète, le filtrage pandas classique prend le relais.
        return gpd.read_file(gpkg_path, layer=layer) if layer else gpd.read_file(gpkg_path)


def _local_gpkg_to_response(dataset_id: str, dataset: Dict[str, str]) -> Dict[str, Any]:
    """Load a local GPKG file (ex. Contours IRIS) and return it as GeoJSON,
    reprojeté en WGS84 pour rester cohérent avec le reste de la carte.

    Filtré sur Toulouse Métropole quand une colonne 'code_insee' existe
    (ex. Contours IRIS, dataset national ~49000 entités trop volumineux à
    traiter en une requête synchrone) — et mis en cache sur disque après le
    premier calcul pour que les chargements suivants soient instantanés.
    """
    import geopandas as gpd

    gpkg_path = BASE_DIR / "data" / dataset["file"]
    if not gpkg_path.exists():
        raise FileNotFoundError(str(gpkg_path))

    safe_cache_name = re.sub(r"[^A-Za-z0-9_-]+", "_", dataset_id)
    cache_path = BASE_DIR / "data" / "cache" / f"{safe_cache_name}_toulouse_metropole.geojson"
    if cache_path.exists() and cache_path.stat().st_mtime >= gpkg_path.stat().st_mtime:
        with cache_path.open("r", encoding="utf-8") as handle:
            geojson = json.load(handle)
        available_layers = geojson.get("_available_layers", [])
        active_layer = geojson.get("_active_layer")
    else:
        try:
            import fiona
            available_layers = fiona.listlayers(str(gpkg_path))
        except Exception:
            available_layers = []

        layer = dataset.get("layer")
        if not layer:
            # Fichier multi-couches sans couche précisée (ex. carte "BD TOPO"
            # générique) : on choisit une couche par défaut raisonnable plutôt
            # que d'échouer — l'utilisateur peut ensuite changer de couche.
            preferred = [name for name in available_layers if _strip_accents(name).lower() in {"batiment", "batiments", "building", "buildings"}]
            if preferred:
                layer = preferred[0]
            elif len(available_layers) == 1:
                layer = available_layers[0]
            elif available_layers:
                layer = available_layers[0]

        gdf = _read_gpkg_layer_filtered(gpkg_path, layer)
        active_layer = layer

        commune_column = _commune_code_column(gdf.columns)
        if commune_column:
            gdf = gdf[gdf[commune_column].astype(str).isin(TOULOUSE_METROPOLE_COMMUNES)]

        # Filet de sécurité supplémentaire : même filtrée sur la Métropole,
        # une couche dense (ex. "batiment") peut encore compter plusieurs
        # centaines de milliers d'entités, trop lourd à sérialiser/afficher
        # en une requête. Échantillonnage déterministe, comme dans le script
        # de PoC existant de l'utilisateur (random_state=42, plafond 30000).
        records_before_sampling = len(gdf)
        sampled = False
        if records_before_sampling > MAX_LOCAL_GPKG_FEATURES:
            gdf = gdf.sample(n=MAX_LOCAL_GPKG_FEATURES, random_state=42)
            sampled = True

        if gdf.crs is not None and str(gdf.crs).upper() not in ("EPSG:4326", "OGC:CRS84"):
            gdf = gdf.to_crs(epsg=4326)

        # geopandas.to_json() échoue sur certains types non nativement JSON
        # (ex. Timestamp des colonnes de date) — conversion en texte de toutes
        # les colonnes non-géométriques, comme dans le script de PoC de
        # l'utilisateur qui contournait déjà ce problème connu.
        geometry_column = gdf.geometry.name
        for column in gdf.columns:
            if column != geometry_column:
                gdf[column] = gdf[column].astype(str)

        geojson = json.loads(gdf.to_json())
        geojson["_available_layers"] = available_layers
        geojson["_active_layer"] = active_layer
        geojson["_records_before_sampling"] = records_before_sampling
        geojson["_sampled"] = sampled
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with cache_path.open("w", encoding="utf-8") as handle:
            json.dump(geojson, handle)

    features = geojson.get("features") or []
    geometry_types = sorted({
        feature.get("geometry", {}).get("type", "Non renseigné")
        for feature in features
        if isinstance(feature, dict)
    })

    # Colonnes de catégorie connues (ex. BD TOPO "batiment" : usage1/usage2) —
    # valeurs distinctes calculées pour alimenter des listes déroulantes de
    # filtrage côté frontend.
    available_categories: Dict[str, list[str]] = {}
    if features:
        first_properties = features[0].get("properties") or {}
        category_columns = [
            key for key in first_properties
            if key.lower().replace("_", "") in {"usage1", "usage2"}
        ]
        for column in category_columns:
            values = sorted({
                value for feature in features
                if (value := (feature.get("properties") or {}).get(column))
                and str(value).strip() and str(value).lower() != "none"
            })
            if values:
                available_categories[column] = values

    return {
        "type": "FeatureCollection",
        "features": features,
        "computed": {
            "metric": None,
            "metric_label": "Sans comptage",
            "metric_total": None,
            "metric_max": None,
        },
        "metadata": {
            "dataset": dataset_id,
            "title": dataset["title"],
            "source_type": "local_gpkg",
            "source_file": dataset["file"],
            "features_displayed": len(features),
            "records_loaded": geojson.get("_records_before_sampling", len(features)),
            "total_api": geojson.get("_records_before_sampling", len(features)),
            "geometry_types": geometry_types,
            "available_layers": geojson.get("_available_layers", []),
            "active_layer": geojson.get("_active_layer"),
            "sampled": geojson.get("_sampled", False),
            "truncated": geojson.get("_sampled", False),
            "available_categories": available_categories,
        },
    }


def _local_csv_to_response(dataset_id: str, dataset: Dict[str, str]) -> Dict[str, Any]:
    """Load a local CSV file (ex. Recensement Population INSEE, filtré Toulouse
    Métropole). Ces fichiers n'ont pas de géométrie propre : la localisation
    passe par le code IRIS (colonne 'iris' / 'IRIS'), à joindre avec le
    référentiel Contours IRIS une fois celui-ci disponible dans le catalogue.
    """
    import csv as _csv

    csv_path = BASE_DIR / "data" / dataset["file"]
    if not csv_path.exists():
        raise FileNotFoundError(str(csv_path))

    try:
        with csv_path.open("r", encoding="utf-8", newline="") as handle:
            reader = _csv.DictReader(handle, delimiter=";")
            records = [dict(row) for row in reader]
    except UnicodeDecodeError:
        with csv_path.open("r", encoding="latin-1", newline="") as handle:
            reader = _csv.DictReader(handle, delimiter=";")
            records = [dict(row) for row in reader]

    features = [
        {"type": "Feature", "geometry": None, "properties": record}
        for record in records
    ]

    return {
        "type": "FeatureCollection",
        "features": features,
        "computed": {
            "metric": None,
            "metric_label": "Sans comptage",
            "metric_total": None,
            "metric_max": None,
        },
        "metadata": {
            "dataset": dataset_id,
            "title": dataset["title"],
            "source_type": "local_csv",
            "source_file": dataset["file"],
            "features_displayed": 0,
            "records_loaded": len(records),
            "total_api": len(records),
            "geometry_types": [],
            "message": (
                "Ce dataset n'a pas de géométrie propre : la localisation se "
                "fait via le code IRIS. Jointure avec Contours IRIS requise "
                "pour l'affichage cartographique (pas encore disponible)."
            ),
        },
    }




__all__ = ['COMMUNE_CODE_COLUMN_CANDIDATES', 'DATASET_OVERRIDES', 'LOCAL_DATASETS', 'MAX_LOCAL_GPKG_FEATURES', 'TOULOUSE_METROPOLE_COMMUNES', '_commune_code_column', '_get_dataset_config', '_local_csv_to_response', '_local_geojson_to_response', '_local_gpkg_to_response', '_peek_gpkg_columns', '_read_gpkg_layer_filtered']
