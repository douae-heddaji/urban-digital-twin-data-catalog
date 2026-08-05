"""Moteur de jointure et d'analyse spatiale : recherche de candidats de jointure entre
datasets, diagnostic spatial, croisement géométrique (intersection/proximité)."""
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
from .catalog import *  # noqa: F401,F403
from .local_sources import *  # noqa: F401,F403


JOIN_KEY_FAMILIES: Dict[str, set[str]] = {
    "station": {"id_station", "station_id", "code_station", "stationcode", "station"},
    "commune": {"code_insee", "insee_com", "code_commune", "nom_commune", "commune"},
    "iris": {"code_iris", "iris", "id_iris"},
    "postal": {"code_postal", "postal_code", "postcode", "cp"},
    "capteur": {"id_capteur", "capteur_id", "sensor_id", "id_sensor"},
    "parking": {"id_parking", "parking_id", "code_parking"},
    "equipement": {"id_equipement", "equipement_id", "code_equipement"},
    "adresse": {"id_adresse", "adresse_id", "ban_id"},
}

ADDRESS_FIELDS = {
    "adresse", "address", "adresse_complete", "numero", "num_voie", "voie",
    "rue", "street", "code_postal", "postal_code", "cp", "commune",
    "nom_commune", "ville", "city"
}

JOIN_SUGGESTIONS: Dict[str, list[Dict[str, str]]] = {
    "station": [
        {"label": "Dataset de localisation des stations", "hint": "Rechercher un dataset contenant la même clé de station et un GeoPoint/GeoShape."},
    ],
    "commune": [
        {"label": "Référentiel géographique des communes", "hint": "Jointure possible sur le code INSEE ou le nom normalisé de la commune."},
    ],
    "iris": [
        {"label": "Contours IRIS", "hint": "Jointure recommandée sur le code IRIS."},
    ],
    "postal": [
        {"label": "Référentiel des codes postaux", "hint": "Le code postal peut donner une localisation approximative, mais plusieurs communes peuvent partager un code."},
    ],
    "capteur": [
        {"label": "Référentiel de localisation des capteurs", "hint": "Rechercher un dataset décrivant les capteurs avec la même clé."},
    ],
    "parking": [
        {"label": "Référentiel des parcs de stationnement", "hint": "Rechercher un dataset de localisation des parkings avec la même clé."},
    ],
    "equipement": [
        {"label": "Référentiel des équipements", "hint": "Rechercher un dataset géographique des équipements avec la même clé."},
    ],
    "adresse": [
        {"label": "Référentiel d’adresses", "hint": "Une jointure sur un identifiant BAN est préférable au géocodage textuel."},
    ],
}


GENERIC_KEY_WORDS = {
    "id", "identifiant", "identifier", "numero", "num", "code", "cle", "key",
    "station", "capteur", "equipement", "parking", "commune", "iris",
    "adresse", "voie", "quartier", "site", "borne", "arret", "ligne"
}

# Champs de mesure ou temporels : ils peuvent contenir par hasard le même nombre
# qu'un identifiant (par exemple tx12c = 21), mais ne doivent jamais servir de clé.
MEASUREMENT_FIELD_WORDS = {
    "temperature", "temp", "tx", "tn", "tx12c", "tn12c", "t", "humidite",
    "humidity", "pression", "pressure", "pluie", "precipitation", "vent",
    "wind", "vitesse", "speed", "direction", "altitude", "hauteur", "niveau",
    "level", "valeur", "value", "mesure", "measure", "moyenne", "minimum",
    "maximum", "min", "max", "total", "somme", "count", "nombre", "date",
    "heure", "time", "timestamp", "annee", "mois", "jour", "emission",
    # Compteurs de statut temps réel (vélos, docks...) : "num_" ne les rend
    # pas identifiants pour autant — ce sont des quantités qui varient, pas
    # des clés d'entité (ex. num_bikes_disabled, num_docks_available).
    "bikes", "bike", "docks", "dock", "disabled", "available", "installed",
    "renting", "returning", "reported",
}

IDENTIFIER_FIELD_WORDS = {
    "id", "identifiant", "identifier", "numero", "num", "code", "cle", "key",
    "station", "capteur", "equipement", "parking", "commune", "iris", "borne",
    "arret", "ligne", "site", "nom", "label", "libelle"
}


def _normalize_join_value(value: Any) -> str:
    """Normalise une valeur avant de l'utiliser comme clé de jointure."""
    raw = _strip_accents(value).strip().lower()
    if not raw:
        return ""
    raw = re.sub(r"\s+", " ", raw)
    raw = re.sub(r"[^a-z0-9]+", "", raw)
    return raw


def _join_value_variants(value: Any) -> set[str]:
    """Return comparable forms without requiring identical column names.

    Example: ``21 Station météo Cugnaux`` yields both the complete normalized
    value and the leading identifier ``21``. This is useful when a foreign key
    is encoded in a dataset title while the geographic reference stores it in
    an ID or label column.
    """
    raw_text = _strip_accents(value).strip().lower()
    normalized = _normalize_join_value(value)
    variants = {normalized} if normalized else set()
    leading_number = re.match(r"^\s*0*(\d{1,12})\b", raw_text)
    if leading_number:
        number = leading_number.group(1)
        variants.update({number, number.zfill(2)})
    return {variant for variant in variants if variant}


def _field_kind(values: list[Any]) -> str:
    """Détermine le type dominant des valeurs d'un champ."""
    cleaned = [str(v).strip() for v in values if v not in (None, "")]
    if not cleaned:
        return "empty"
    numeric = sum(bool(re.fullmatch(r"[-+]?\d+(?:[.,]\d+)?", v)) for v in cleaned)
    return "numeric" if numeric / len(cleaned) >= 0.9 else "text"


def _field_tokens(field: str) -> set[str]:
    """Découpe et normalise le nom d'un champ pour l'analyse de similarité."""
    normalized = _normalize_field_name(field)
    tokens = set(normalized.split("_"))
    tokens.add(normalized)
    return {token for token in tokens if token}


def _is_measurement_field(field: str) -> bool:
    """Indique si un champ correspond principalement à une mesure plutôt qu'à un identifiant."""
    tokens = _field_tokens(field)
    normalized = _normalize_field_name(field)
    if tokens & MEASUREMENT_FIELD_WORDS:
        return True
    # Variables météorologiques codées : tx12c, tn12c, rr24, ff10, etc.
    return bool(re.fullmatch(r"(?:tx|tn|rr|ff|dd|u|p|h|n|t)[0-9a-z_]*", normalized))


def _is_identifier_field(field: str) -> bool:
    """Indique si un champ peut servir d'identifiant ou de clé de jointure."""
    if _is_measurement_field(field):
        return False
    normalized = _normalize_field_name(field)
    tokens = _field_tokens(field)
    return (
        bool(tokens & IDENTIFIER_FIELD_WORDS)
        or normalized.startswith(("id_", "code_", "numero_", "num_"))
        or normalized.endswith(("_id", "_code", "_numero", "_num", "_nom"))
    )


def _canonical_distinct(values: list[Any]) -> set[str]:
    # Une seule forme canonique par cellule pour éviter une unicité > 100 %.
    """Construit l'ensemble des valeurs distinctes après normalisation canonique."""
    return {v for value in values if (v := _normalize_join_value(value))}


def _canonical_join_key(value: Any) -> str:
    """Forme canonique d'une valeur de clé de jointure, utilisée pour regrouper
    les enregistrements d'une même entité malgré des représentations brutes
    différentes (ex. 5, "05" et 5.0 doivent former UN seul groupe, pas trois)."""
    variants = _join_value_variants(value)
    if not variants:
        return ""
    digit_variants = [v for v in variants if v.isdigit()]
    if digit_variants:
        # La forme numérique la plus courte est la forme sans zéro de tête
        # ni artefact de type (ex. "50" issu de "5.0" est écarté au profit de "5").
        return min(digit_variants, key=len)
    return sorted(variants)[0]


def _candidate_source_fields(records: list[Dict[str, Any]], title: str) -> Dict[str, Dict[str, Any]]:
    """Analyse les champs du jeu source susceptibles d'être utilisés pour une jointure."""
    profiles: Dict[str, Dict[str, Any]] = {}
    columns = sorted({key for record in records for key in record.keys()})
    for field in columns:
        values = _scalar_values(records, field)
        if not values:
            continue
        normalized_name = _normalize_field_name(field)
        tokens = _field_tokens(field)
        distinct = {variant for value in values for variant in _join_value_variants(value)}
        canonical_distinct = _canonical_distinct(values)
        if not distinct:
            continue
        uniqueness = min(1.0, len(canonical_distinct) / max(len(values), 1))
        key_like = _is_identifier_field(field)
        # On garde aussi les colonnes à cardinalité raisonnable : les noms peuvent être différents.
        if key_like or len(distinct) <= 500 or uniqueness >= 0.3:
            profiles[field] = {
                "field": field, "values": distinct, "kind": _field_kind(values),
                "filled": len(values), "distinct": len(distinct), "uniqueness": uniqueness,
                "name_tokens": tokens, "origin": "column", "key_like": key_like,
            }

    # Identifiants encodés dans le titre (ex. « 21 Station météo ... »).
    title_match = re.match(r"^\s*0*(\d{1,8})\b", title or "")
    if title_match:
        value = title_match.group(1)
        profiles["__title_identifier__"] = {
            "field": "Identifiant extrait du titre", "values": {value, value.zfill(2)},
            "kind": "numeric", "filled": 1, "distinct": 1, "uniqueness": 1.0,
            "name_tokens": {"id", "numero"}, "origin": "title_number", "key_like": True,
        }

    # Le titre complet normalisé permet de retrouver une clé textuelle telle que
    # id_nom = "21-station-meteo-cugnaux-general-de-gaulle". Cette correspondance
    # est plus fiable qu'un simple numéro isolé.
    title_normalized = _normalize_join_value(title)
    if title_normalized and len(title_normalized) >= 5:
        profiles["__title_label__"] = {
            "field": "Libellé extrait du titre", "values": {title_normalized},
            "kind": "text", "filled": 1, "distinct": 1, "uniqueness": 1.0,
            "name_tokens": _catalog_tokens(title) | {"nom", "label"},
            "origin": "title_label", "key_like": True,
        }
    return profiles


def _candidate_target_fields(records: list[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Analyse les champs du jeu cible susceptibles d'être utilisés pour une jointure."""
    profiles: Dict[str, Dict[str, Any]] = {}
    columns = sorted({key for record in records for key in record.keys()})
    for field in columns:
        values = _scalar_values(records, field)
        if not values:
            continue
        distinct = {variant for value in values for variant in _join_value_variants(value)}
        if not distinct:
            continue
        normalized_name = _normalize_field_name(field)
        tokens = _field_tokens(field)
        canonical_distinct = _canonical_distinct(values)
        uniqueness = min(1.0, len(canonical_distinct) / max(len(values), 1))
        key_like = _is_identifier_field(field)
        if _is_measurement_field(field):
            continue
        # Les colonnes textuelles très uniques peuvent servir de libellé, mais les
        # colonnes numériques ne sont retenues que lorsqu'elles ressemblent à une clé.
        if key_like or (_field_kind(values) == "text" and uniqueness >= 0.8):
            profiles[field] = {
                "field": field, "values": distinct, "kind": _field_kind(values),
                "filled": len(values), "distinct": len(canonical_distinct), "uniqueness": uniqueness,
                "name_tokens": tokens, "key_like": key_like,
            }
    return profiles


def _compare_field_profiles(source: Dict[str, Any], target: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Compare deux profils de champs et calcule leur compatibilité pour une jointure."""
    if source["kind"] != target["kind"] and "empty" not in {source["kind"], target["kind"]}:
        return None
    # Un numéro extrait du titre ne peut rejoindre qu'une vraie colonne d'identifiant.
    if source.get("origin") == "title_number" and not target.get("key_like"):
        return None
    source_values = source["values"]
    target_values = target["values"]
    common = source_values & target_values
    if not common:
        return None
    source_coverage = min(1.0, len(common) / max(len(source_values), 1))
    target_uniqueness = min(1.0, max(0.0, target["uniqueness"]))
    name_similarity = len(source["name_tokens"] & target["name_tokens"]) / max(len(source["name_tokens"] | target["name_tokens"]), 1)
    identifier_bonus = 18 if target.get("key_like") else 0
    exact_label_bonus = 30 if source.get("origin") == "title_label" else 0
    score = 45 * source_coverage + 22 * target_uniqueness + 10 * name_similarity + identifier_bonus + exact_label_bonus
    if source.get("origin") == "title_number":
        score += 8
    # Un champ source qui ne ressemble pas lui-même à un identifiant (ex. un
    # numéro de version, un statut, un compteur à faible cardinalité inclus
    # via la tolérance "cardinalité raisonnable") ne doit jamais l'emporter
    # sur un vrai identifiant simplement parce que ses quelques valeurs
    # chevauchent par hasard celles d'une colonne cible. Sans ce garde-fou,
    # "version" (valeurs 0-9) matchait "id_local" (valeurs 0-9) par pure
    # coïncidence numérique, avec un score plus élevé qu'un vrai match
    # station_id ↔ station_id à couverture plus faible.
    source_key_like = bool(source.get("key_like")) or source.get("origin") in ("title_label", "title_number")
    if not source_key_like:
        score *= 0.35
    return {
        "source_field": source["field"],
        "target_field": target["field"],
        "source_coverage": round(source_coverage, 3),
        "target_uniqueness": round(target_uniqueness, 3),
        "name_similarity": round(name_similarity, 3),
        "common_examples": sorted(common)[:5],
        "value_score": round(score, 1),
        "source_origin": source.get("origin"),
    }


def _shortlist_catalog_candidates(dataset_id: str, title: str, max_candidates: int = 8) -> list[Dict[str, Any]]:
    """Présélectionne dans le catalogue les jeux de données les plus proches du jeu source."""
    source_tokens = _catalog_tokens(title)
    scored = []
    for entry in _load_catalog_entries():
        if entry["dataset_id"] == dataset_id or not entry["geo_hint"]:
            continue
        overlap = len(source_tokens & entry["tokens"])
        union = len(source_tokens | entry["tokens"]) or 1
        semantic = overlap / union
        phrase_bonus = 0.0
        source_text = _strip_accents(title).lower()
        target_text = _strip_accents(entry["title"] + " " + entry["comments"]).lower()
        for phrase in ("station meteo", "parking", "capteur", "ecole", "commune", "iris", "quartier", "equipement"):
            if phrase in source_text and phrase in target_text:
                phrase_bonus += 0.25
        score = semantic + phrase_bonus
        if score > 0:
            scored.append((score, entry))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [dict(entry, metadata_score=round(score, 3)) for score, entry in scored[:max_candidates]]


def _find_join_candidates(dataset_id: str, title: str, source_records: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    """Recherche et classe les meilleurs jeux de données et champs candidats pour une jointure."""
    source_profiles = _candidate_source_fields(source_records, title)
    if not source_profiles:
        return []
    source_config = _get_dataset_config(dataset_id)
    source_id_field = (source_config or {}).get("id_field") if source_config else None
    shortlisted = _shortlist_catalog_candidates(dataset_id, title)
    shortlisted_ids = {entry["dataset_id"] for entry in shortlisted}
    if source_id_field:
        family = next((fam for fam, names in JOIN_KEY_FAMILIES.items() if source_id_field in names), None)
        if family:
            catalog_by_id = {entry["dataset_id"]: entry for entry in _load_catalog_entries()}
            for local_id, local_cfg in LOCAL_DATASETS.items():
                if local_id == dataset_id or local_id in shortlisted_ids:
                    continue
                if local_cfg.get("id_field") in JOIN_KEY_FAMILIES.get(family, set()):
                    entry = catalog_by_id.get(local_id)
                    if entry:
                        # Score sémantique forcé : même famille de clé de jointure
                        # déclarée explicitement (ex. "iris"/"code_iris"), pas
                        # besoin de dépendre du recoupement de mots dans le titre.
                        shortlisted.append(dict(entry, metadata_score=0.5))
                        shortlisted_ids.add(local_id)

    candidates = []
    for entry in shortlisted:
        try:
            candidate_config = _get_dataset_config(entry["dataset_id"])
            if candidate_config and candidate_config.get("source_type") in {"local_geojson", "local_gpkg"}:
                loader = _local_geojson_to_response if candidate_config["source_type"] == "local_geojson" else _local_gpkg_to_response
                local_response = loader(entry["dataset_id"], candidate_config)
                target_records = [
                    {**(feature.get("properties") or {}), "geometry": feature.get("geometry")}
                    for feature in local_response.get("features", [])[:2000]
                ]
            else:
                all_raw, _, _, _, _ = _fetch_paginated_records(
                    _build_toulouse_records_url(entry["dataset_id"]), max_records=500
                )
                target_records = [r for item in all_raw if (r := _flatten_record(item))]
        except (requests.RequestException, ValueError, FileNotFoundError):
            continue
        if not any(_geometry_from_record(record) for record in target_records):
            continue
        target_profiles = _candidate_target_fields(target_records)
        best_pair = None
        for source in source_profiles.values():
            for target in target_profiles.values():
                comparison = _compare_field_profiles(source, target)
                if comparison and (best_pair is None or comparison["value_score"] > best_pair["value_score"]):
                    best_pair = comparison
        semantic_points = min(20.0, entry["metadata_score"] * 20)
        if best_pair:
            total_score = best_pair["value_score"] + semantic_points
            target_text = _strip_accents(f"{entry['title']} {entry['comments']} {entry['attributes']}").lower()
            # Les historiques de mesures sont pénalisés : une valeur observée n'est
            # pas une clé d'entité. Une correspondance exacte du libellé reste admise.
            temporal_measure_dataset = bool(re.search(r"histor|observation|mesure|releve|temps reel|horaire", target_text))
            if temporal_measure_dataset and best_pair.get("source_origin") != "title_label":
                total_score -= 35
            # Un identifiant numérique isolé extrait du titre (souvent un petit
            # nombre comme "38") a une probabilité non négligeable de coïncider
            # par pur hasard avec l'identifiant d'un dataset totalement sans
            # rapport (ex. une station météo n°38 contre une station VéloToulouse
            # n°38) — un seul chiffre ne porte quasiment aucune information.
            # Sans lien thématique réel entre les deux datasets (peu ou pas de
            # mots-clés communs), ce n'est pas une preuve fiable de jointure.
            if best_pair.get("source_origin") == "title_number" and entry["metadata_score"] < 0.2:
                total_score -= 60
            total_score = min(100.0, max(0.0, total_score))
        else:
            # Candidat sémantique uniquement : utile à afficher, mais pas comme jointure validée.
            total_score = min(39.0, semantic_points + 10)
        if total_score < 25:
            continue
        confidence = "élevée" if total_score >= 80 else "moyenne" if total_score >= 60 else "faible"
        candidates.append({
            "dataset_id": entry["dataset_id"],
            "title": entry["title"],
            "theme": entry["theme"],
            "score": round(total_score, 1),
            "confidence": confidence,
            "metadata_score": entry["metadata_score"],
            "source_field": best_pair["source_field"] if best_pair else None,
            "target_field": best_pair["target_field"] if best_pair else None,
            "source_coverage": best_pair["source_coverage"] if best_pair else None,
            "target_uniqueness": best_pair["target_uniqueness"] if best_pair else None,
            "common_examples": best_pair["common_examples"] if best_pair else [],
            "verified_by_values": bool(best_pair),
            "geometry_records_sampled": sum(1 for record in target_records if _geometry_from_record(record)),
        })
    candidates.sort(key=lambda item: item["score"], reverse=True)
    return candidates[:5]


def _spatial_diagnostic_from_records(dataset_id: str, raw_records: list[Any], title: str = "") -> Dict[str, Any]:
    """Évalue automatiquement le potentiel spatial d'un jeu de données à partir de ses enregistrements."""
    records = [record for item in raw_records if (record := _flatten_record(item))]
    columns = sorted({key for record in records for key in record.keys()})
    normalized_columns = {_normalize_field_name(column): column for column in columns}

    direct_features = sum(1 for record in records if _geometry_from_record(record))
    if direct_features:
        return {
            "dataset": dataset_id,
            "title": title or dataset_id,
            "status": "direct_geo",
            "status_label": "Cartographiable directement",
            "confidence": "élevée",
            "records_sampled": len(records),
            "direct_geometry_records": direct_features,
            "columns": columns,
            "message": "Une géométrie exploitable a été détectée dans les enregistrements échantillonnés.",
        }

    detected_keys = []
    detected_families = []
    for family, aliases in JOIN_KEY_FAMILIES.items():
        for alias in aliases:
            if alias in normalized_columns:
                original = normalized_columns[alias]
                profile = _field_profile(records, original)
                profile["family"] = family
                profile["suggestions"] = JOIN_SUGGESTIONS.get(family, [])
                detected_keys.append(profile)
                detected_families.append(family)

    if detected_keys:
        best = sorted(
            detected_keys,
            key=lambda item: (item["filled"], item["uniqueness_ratio"]),
            reverse=True,
        )[0]
        confidence = "élevée" if best["filled"] >= 10 and best["uniqueness_ratio"] >= 0.5 else "moyenne"
        return {
            "dataset": dataset_id,
            "title": title or dataset_id,
            "status": "join_required",
            "status_label": "Jointure géographique potentielle",
            "confidence": confidence,
            "records_sampled": len(records),
            "join_keys": detected_keys,
            "families": sorted(set(detected_families)),
            "columns": columns,
            "message": "Aucune géométrie directe n’a été détectée, mais une ou plusieurs clés de jointure potentielles sont présentes.",
        }

    address_matches = [
        normalized_columns[name]
        for name in ADDRESS_FIELDS
        if name in normalized_columns
    ]
    if address_matches:
        return {
            "dataset": dataset_id,
            "title": title or dataset_id,
            "status": "geocoding_possible",
            "status_label": "Géocodage possible",
            "confidence": "moyenne",
            "records_sampled": len(records),
            "address_fields": sorted(set(address_matches)),
            "columns": columns,
            "message": "Des champs d’adresse ont été détectés. La localisation peut être obtenue par géocodage, après contrôle de la qualité des adresses.",
        }

    return {
        "dataset": dataset_id,
        "title": title or dataset_id,
        "status": "not_spatial",
        "status_label": "Non cartographiable automatiquement",
        "confidence": "élevée",
        "records_sampled": len(records),
        "columns": columns,
        "message": "Aucune géométrie, clé de jointure connue ou adresse exploitable n’a été détectée dans l’échantillon.",
    }


def _geometry_family(gdf) -> str:
    """Return the dominant geometry family of a GeoDataFrame."""
    if gdf is None or gdf.empty:
        return "unknown"
    types = gdf.geometry.geom_type.dropna().astype(str)
    if types.empty:
        return "unknown"
    families = []
    for geom_type in types:
        if "Point" in geom_type:
            families.append("point")
        elif "Line" in geom_type:
            families.append("line")
        elif "Polygon" in geom_type:
            families.append("polygon")
    if not families:
        return "unknown"
    return max(set(families), key=families.count)


def _prepare_analysis_gdf(feature_collection: Dict[str, Any], dataset_id: str, title: str):
    """Convertit et prépare un jeu GeoJSON pour les opérations d'analyse spatiale."""
    import geopandas as gpd

    features = feature_collection.get("features") if isinstance(feature_collection, dict) else None
    if not isinstance(features, list) or not features:
        raise ValueError(f"Le dataset « {title} » ne contient aucun objet géographique à analyser.")

    gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    if gdf.empty or "geometry" not in gdf:
        raise ValueError(f"Le dataset « {title} » ne contient aucune géométrie exploitable.")
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    if gdf.empty:
        raise ValueError(f"Le dataset « {title} » ne contient aucune géométrie valide.")
    # Répare autant que possible les polygones invalides sans modifier les points/lignes.
    try:
        invalid = ~gdf.geometry.is_valid
        if invalid.any():
            gdf.loc[invalid, "geometry"] = gdf.loc[invalid, "geometry"].make_valid()
    except Exception:
        pass
    gdf["_source_dataset"] = dataset_id
    gdf["_source_title"] = title
    gdf["_source_index"] = list(range(len(gdf)))
    return gdf


def _gdf_feature_collection(gdf, extra_properties: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Convertit un GeoDataFrame en FeatureCollection GeoJSON en ajoutant les propriétés demandées."""
    if gdf is None or gdf.empty:
        return {"type": "FeatureCollection", "features": []}
    output = gdf.to_crs("EPSG:4326").copy()
    if extra_properties:
        for key, value in extra_properties.items():
            output[key] = value
    return json.loads(output.to_json(drop_id=True))


def _automatic_spatial_analysis(
    collection_a: Dict[str, Any],
    collection_b: Dict[str, Any],
    dataset_a: Dict[str, str],
    dataset_b: Dict[str, str],
    distance_m: float,
) -> Dict[str, Any]:
    """Automatically choose a relevant spatial relation from geometry families."""
    import geopandas as gpd

    a = _prepare_analysis_gdf(collection_a, dataset_a["id"], dataset_a["title"])
    b = _prepare_analysis_gdf(collection_b, dataset_b["id"], dataset_b["title"])
    family_a, family_b = _geometry_family(a), _geometry_family(b)
    if "unknown" in {family_a, family_b}:
        raise ValueError("Le type de géométrie d'au moins un dataset n'a pas pu être détecté.")

    # EPSG:2154 est métrique et adapté à Toulouse / France métropolitaine.
    a_m = a.to_crs("EPSG:2154")
    b_m = b.to_crs("EPSG:2154")
    distance_m = max(0.0, min(float(distance_m or 0), 100000.0))
    pair = {family_a, family_b}

    result_layers = []
    relation_label = "Intersection spatiale"
    operation = "intersects"
    matched_a = set()
    matched_b = set()
    result_geometry_count = 0
    pairs: list[tuple[int, int]] = []  # (index dans a, index dans b) pour chaque correspondance trouvée

    if pair == {"point"} or pair == {"point", "line"}:
        operation = "proximity"
        relation_label = f"Proximité à moins de {distance_m:g} m"
        # jointure du plus petit jeu vers le plus grand pour limiter le coût.
        joined = gpd.sjoin_nearest(
            a_m, b_m[["geometry", "_source_index"]].rename(columns={"_source_index": "_source_index_b"}),
            how="inner", max_distance=distance_m, distance_col="_distance_m"
        )
        matched_a = set(joined["_source_index"].astype(int).tolist())
        matched_b = set(joined["_source_index_b"].astype(int).tolist())
        pairs = list(zip(joined["_source_index"].astype(int).tolist(), joined["_source_index_b"].astype(int).tolist()))
    elif pair == {"point", "polygon"}:
        operation = "within"
        relation_label = "Points contenus dans les zones"
        if family_a == "point":
            points, polygons = a_m, b_m
            point_is_a = True
        else:
            points, polygons = b_m, a_m
            point_is_a = False
        joined = gpd.sjoin(
            points, polygons[["geometry", "_source_index"]].rename(columns={"_source_index": "_source_index_polygon"}),
            how="inner", predicate="within"
        )
        point_ids = set(joined["_source_index"].astype(int).tolist())
        polygon_ids = set(joined["_source_index_polygon"].astype(int).tolist())
        if point_is_a:
            matched_a, matched_b = point_ids, polygon_ids
            pairs = list(zip(joined["_source_index"].astype(int).tolist(), joined["_source_index_polygon"].astype(int).tolist()))
        else:
            matched_a, matched_b = polygon_ids, point_ids
            pairs = list(zip(joined["_source_index_polygon"].astype(int).tolist(), joined["_source_index"].astype(int).tolist()))
    elif pair == {"polygon"}:
        operation = "overlay_intersection"
        relation_label = "Zones de chevauchement"
        intersections = gpd.overlay(a_m, b_m, how="intersection", keep_geom_type=False)
        intersections = intersections[intersections.geometry.notna() & ~intersections.geometry.is_empty].copy()
        result_geometry_count = len(intersections)
        if not intersections.empty:
            intersections["_analysis_role"] = "intersection"
            intersections["_analysis_label"] = relation_label
            result_layers.append({
                "id": "analysis-intersection",
                "title": "Intersection des deux datasets",
                "role": "intersection",
                "geojson": _gdf_feature_collection(intersections),
            })
            # gpd.overlay suffixe les colonnes en collision (les deux gdf ont
            # "_source_index") avec _1/_2 : ce sont les vraies paires a/b.
            idx_a_col = "_source_index_1" if "_source_index_1" in intersections.columns else "_source_index"
            idx_b_col = "_source_index_2" if "_source_index_2" in intersections.columns else "_source_index_b"
            if idx_a_col in intersections.columns and idx_b_col in intersections.columns:
                pairs = list(zip(intersections[idx_a_col].astype(int).tolist(), intersections[idx_b_col].astype(int).tolist()))
                matched_a = set(p[0] for p in pairs)
                matched_b = set(p[1] for p in pairs)
    else:
        # Ligne/ligne et ligne/polygone : objets qui se croisent réellement.
        operation = "intersects"
        relation_label = "Objets qui s'intersectent"
        joined = gpd.sjoin(
            a_m, b_m[["geometry", "_source_index"]].rename(columns={"_source_index": "_source_index_b"}),
            how="inner", predicate="intersects"
        )
        matched_a = set(joined["_source_index"].astype(int).tolist())
        matched_b = set(joined["_source_index_b"].astype(int).tolist())
        pairs = list(zip(joined["_source_index"].astype(int).tolist(), joined["_source_index_b"].astype(int).tolist()))

    if operation != "overlay_intersection":
        matched_a_gdf = a_m[a_m["_source_index"].isin(matched_a)].copy()
        matched_b_gdf = b_m[b_m["_source_index"].isin(matched_b)].copy()
        matched_a_gdf["_analysis_role"] = "matched_a"
        matched_b_gdf["_analysis_role"] = "matched_b"
        matched_a_gdf["_analysis_label"] = relation_label
        matched_b_gdf["_analysis_label"] = relation_label
        result_layers.extend([
            {"id": dataset_a["id"], "title": dataset_a["title"], "role": "matched_a", "geojson": _gdf_feature_collection(matched_a_gdf)},
            {"id": dataset_b["id"], "title": dataset_b["title"], "role": "matched_b", "geojson": _gdf_feature_collection(matched_b_gdf)},
        ])

    return {
        "mode": "automatic",
        "operation": operation,
        "relation_label": relation_label,
        "geometry_types": {"dataset_a": family_a, "dataset_b": family_b},
        "distance_m": distance_m if operation == "proximity" else None,
        "summary": {
            "dataset_a_total": len(a),
            "dataset_b_total": len(b),
            "dataset_a_matched": len(matched_a),
            "dataset_b_matched": len(matched_b),
            "intersection_geometries": result_geometry_count,
        },
        "layers": result_layers,
        # Non sérialisés vers le frontend (retirés avant jsonify par l'appelant
        # HTTP) : utiles pour reconstruire un export fusionné sans relancer
        # tout le calcul spatial.
        "_pairs": pairs,
        "_gdf_a": a,
        "_gdf_b": b,
    }


def _multi_spatial_analysis(items: list[Dict[str, Any]], distance_m: float) -> Dict[str, Any]:
    """Analyse 2 à N couches en calculant toutes les relations deux à deux.

    Pour N couches, on ne recherche pas une unique zone où les N géométries se
    superposent simultanément, car ce critère est souvent trop strict. On calcule
    plutôt chaque paire (A-B, A-C, B-C, ...), puis on rassemble les objets qui
    participent à au moins une intersection ou proximité.
    """
    import geopandas as gpd
    from itertools import combinations
    from shapely.ops import unary_union

    if len(items) < 2:
        raise ValueError("Coche au moins deux datasets pour une analyse multiple.")
    if len(items) > 12:
        raise ValueError("L'analyse multiple est limitée à 12 datasets pour préserver les performances.")

    distance_m = max(0.0, min(float(distance_m or 0), 100000.0))
    prepared = []
    for item in items:
        dataset = item.get("dataset") or {}
        collection = item.get("collection") or {}
        dataset_id = str(dataset.get("id") or "").strip()
        title = str(dataset.get("title") or dataset_id).strip()
        if not dataset_id:
            raise ValueError("Un dataset sélectionné ne possède pas d'identifiant.")
        gdf = _prepare_analysis_gdf(collection, dataset_id, title).to_crs("EPSG:2154")
        prepared.append({
            "id": dataset_id,
            "title": title,
            "gdf": gdf,
            "family": _geometry_family(gdf),
        })

    radius = distance_m / 2.0
    matched_indexes: Dict[str, set] = {item["id"]: set() for item in prepared}
    pair_zones = []
    pair_results = []

    for left, right in combinations(prepared, 2):
        left_geoms = left["gdf"].geometry
        right_geoms = right["gdf"].geometry
        left_influence = unary_union(list(left_geoms.buffer(radius) if radius > 0 else left_geoms))
        right_influence = unary_union(list(right_geoms.buffer(radius) if radius > 0 else right_geoms))
        zone = left_influence.intersection(right_influence)

        if zone.is_empty:
            pair_results.append({
                "dataset_a": left["id"], "dataset_b": right["id"],
                "title_a": left["title"], "title_b": right["title"],
                "matched_a": 0, "matched_b": 0, "has_intersection": False,
            })
            continue

        pair_zones.append(zone)
        selection_area = zone.buffer(radius) if radius > 0 else zone
        left_mask = left["gdf"].geometry.intersects(selection_area)
        right_mask = right["gdf"].geometry.intersects(selection_area)
        left_ids = set(left["gdf"].index[left_mask].tolist())
        right_ids = set(right["gdf"].index[right_mask].tolist())
        matched_indexes[left["id"]].update(left_ids)
        matched_indexes[right["id"]].update(right_ids)
        pair_results.append({
            "dataset_a": left["id"], "dataset_b": right["id"],
            "title_a": left["title"], "title_b": right["title"],
            "matched_a": len(left_ids), "matched_b": len(right_ids),
            "has_intersection": True,
        })

    result_layers = []
    if pair_zones:
        combined_zone = unary_union(pair_zones)
        zone_gdf = gpd.GeoDataFrame(
            [{"_analysis_role": "intersection", "_analysis_label": "Zones de croisement entre les couches cochées"}],
            geometry=[combined_zone], crs="EPSG:2154"
        )
        result_layers.append({
            "id": "analysis-multi-pairwise-intersections",
            "title": "Zones de croisement multi-couches",
            "role": "intersection",
            "geojson": _gdf_feature_collection(zone_gdf),
        })

    matched_counts: Dict[str, int] = {}
    for item in prepared:
        indexes = sorted(matched_indexes[item["id"]])
        matched = item["gdf"].loc[indexes].copy() if indexes else item["gdf"].iloc[0:0].copy()
        matched["_analysis_role"] = "matched_multi"
        matched["_analysis_label"] = f"Objet participant à au moins un croisement ({distance_m:g} m)"
        matched_counts[item["id"]] = len(matched)
        result_layers.append({
            "id": item["id"],
            "title": item["title"],
            "role": "matched_multi",
            "geojson": _gdf_feature_collection(matched),
        })

    nonempty_pairs = sum(1 for pair in pair_results if pair["has_intersection"])
    return {
        "mode": "multi",
        "operation": "multi_pairwise_intersections",
        "relation_label": f"Croisements entre {len(prepared)} datasets à {distance_m:g} m",
        "distance_m": distance_m,
        "geometry_types": {item["id"]: item["family"] for item in prepared},
        "summary": {
            "dataset_count": len(prepared),
            "pair_count": len(pair_results),
            "nonempty_pair_count": nonempty_pairs,
            "matched_by_dataset": matched_counts,
            "intersection_geometries": len(pair_zones),
        },
        "pair_results": pair_results,
        "layers": result_layers,
    }




__all__ = ['ADDRESS_FIELDS', 'GENERIC_KEY_WORDS', 'IDENTIFIER_FIELD_WORDS', 'JOIN_KEY_FAMILIES', 'JOIN_SUGGESTIONS', 'MEASUREMENT_FIELD_WORDS', '_automatic_spatial_analysis', '_candidate_source_fields', '_candidate_target_fields', '_canonical_distinct', '_canonical_join_key', '_compare_field_profiles', '_field_kind', '_field_tokens', '_find_join_candidates', '_gdf_feature_collection', '_geometry_family', '_is_identifier_field', '_is_measurement_field', '_join_value_variants', '_multi_spatial_analysis', '_normalize_join_value', '_prepare_analysis_gdf', '_shortlist_catalog_candidates', '_spatial_diagnostic_from_records']
