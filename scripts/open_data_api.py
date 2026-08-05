"""Appels à l'API OpenDataSoft (Toulouse Métropole + autres portails) et à data.gouv.fr :
récupération de schémas, pagination, détection/filtrage temporel, conversion des
enregistrements en GeoJSON."""
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


TOULOUSE_ODS_DOMAIN = "data.toulouse-metropole.fr"
TOULOUSE_ODS_BASE = f"https://{TOULOUSE_ODS_DOMAIN}/api/explore/v2.1/catalog/datasets"
# Domaines pour lesquels on garde l'identifiant "nu" (sans préfixe ods::), pour
# rester compatible avec tous les identifiants Toulouse déjà câblés en dur
# ailleurs dans l'app (historique, exceptions, datasets de référence, etc.).
LEGACY_ODS_DOMAINS = {TOULOUSE_ODS_DOMAIN, "toulouse-metropole.opendatasoft.com"}
DATASET_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,199}$")
# Un domaine (ex. data.haute-garonne.fr) : lettres/chiffres/tirets séparés par des points.
ODS_DOMAIN_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
ODS_ID_PREFIX = "ods::"
# Identifiant composé pour tout portail OpenDataSoft autre que Toulouse Métropole :
# "ods::<domaine>::<slug-du-dataset>".
ODS_COMPOUND_ID_PATTERN = re.compile(rf"^{re.escape(ODS_ID_PREFIX)}([a-z0-9.-]+)::([a-z0-9][a-z0-9_-]{{0,199}})$")
GENERIC_API_MAX_RECORDS = 9_900  # ODS Explore v2.1 /records requires offset+limit < 10 000
DATA_GOUV_PREFIX = "datagouv--"
DATA_GOUV_CACHE_DIR = BASE_DIR / "data" / "cache" / "data_gouv"
DATA_GOUV_CONNECTOR = DataGouvConnector(DATA_GOUV_CACHE_DIR)


def _build_ods_base(domain: str) -> str:
    """Construit l'URL de base de l'API OpenDataSoft pour un domaine donné."""
    return f"https://{domain}/api/explore/v2.1/catalog/datasets"


def _make_ods_dataset_id(domain: str, slug: str) -> str:
    """Construit l'identifiant utilisé dans toute l'app pour un dataset OpenDataSoft.

    Toulouse Métropole garde un identifiant simple (compatibilité avec tout ce qui
    est déjà câblé en dur ailleurs) ; tout autre portail est préfixé par son domaine.
    """
    domain = domain.lower().strip()
    slug = slug.lower().strip()
    if domain in LEGACY_ODS_DOMAINS:
        return slug
    return f"{ODS_ID_PREFIX}{domain}::{slug}"


def _parse_ods_dataset_id(dataset_id: str) -> Tuple[str, str]:
    """Retourne (domaine, slug) pour un identifiant de dataset OpenDataSoft,
    qu'il soit au format composé ('ods::domaine::slug') ou simple (implicitement
    Toulouse Métropole, pour compatibilité avec l'existant)."""
    match = ODS_COMPOUND_ID_PATTERN.fullmatch(dataset_id)
    if match:
        return match.group(1), match.group(2)
    return TOULOUSE_ODS_DOMAIN, dataset_id


def _is_known_dataset_id_shape(dataset_id: str) -> bool:
    """Valide la forme d'un identifiant de dataset (Toulouse implicite, local,
    data.gouv.fr, ou portail OpenDataSoft générique), sans vérifier son existence."""
    if DATASET_ID_PATTERN.fullmatch(dataset_id):
        return True
    match = ODS_COMPOUND_ID_PATTERN.fullmatch(dataset_id)
    return bool(match and ODS_DOMAIN_PATTERN.fullmatch(match.group(1)))

def _strip_accents(value: Any) -> str:
    """Supprime les accents afin de faciliter les comparaisons textuelles."""
    return "".join(
        char for char in unicodedata.normalize("NFD", str(value or ""))
        if unicodedata.category(char) != "Mn"
    )


def _build_toulouse_records_url(dataset_id: str) -> str:
    """Construit l'URL des enregistrements pour n'importe quel portail OpenDataSoft
    (le nom est conservé pour limiter le diff, mais ne se limite plus à Toulouse)."""
    domain, slug = _parse_ods_dataset_id(dataset_id)
    return f"{_build_ods_base(domain)}/{slug}/records"




def _extract_ods_field_names(payload: Any) -> list[str]:
    """Extract the published field names from an OpenDataSoft dataset metadata payload."""
    names, _ = _extract_ods_fields_with_labels(payload)
    return names


def _extract_ods_fields_with_labels(payload: Any) -> tuple[list[str], Dict[str, str]]:
    """Same field extraction as _extract_ods_field_names, but also returns the
    human-readable label the API provides for each field when available (ex.
    "Température" for the technical field "t") — the raw name stays the real
    identifier used for API calls/joins, the label is only for display."""
    candidates = []
    if isinstance(payload, dict):
        dataset = payload.get("dataset") if isinstance(payload.get("dataset"), dict) else payload
        for key in ("fields", "field", "schema"):
            value = dataset.get(key) if isinstance(dataset, dict) else None
            if isinstance(value, list):
                candidates.extend(value)
        metas = dataset.get("metas") if isinstance(dataset, dict) and isinstance(dataset.get("metas"), dict) else {}
        default_meta = metas.get("default") if isinstance(metas.get("default"), dict) else {}
        for key in ("fields", "field", "schema"):
            value = default_meta.get(key)
            if isinstance(value, list):
                candidates.extend(value)
    names = []
    labels: Dict[str, str] = {}
    for item in candidates:
        if isinstance(item, str):
            name = item.strip()
            label = ""
        elif isinstance(item, dict):
            name = str(item.get("name") or item.get("id") or item.get("field") or "").strip()
            label = str(item.get("label") or item.get("title") or "").strip()
        else:
            name, label = "", ""
        if name and name not in names:
            names.append(name)
        if name and label and label.lower() != name.lower() and name not in labels:
            labels[name] = label
    return names, labels


def _classify_attribute_name(name: str) -> str:
    """Classe un attribut dans une catégorie fonctionnelle à partir de son nom."""
    normalized = _normalize_field_name(name)
    if re.search(r"(?:^|_)(?:geo|geom|shape|latitude|longitude|lat|lon|lng|x|y|coordonnees|localisation)(?:_|$)", normalized):
        return "location"
    if re.search(r"(?:^|_)(?:date|heure|time|timestamp|datetime|annee|mois|jour|started|ended|utc|paris|reported|updated|modified|refreshed|processed|created|changed)(?:_|$)", normalized):
        return "temporal"
    if re.search(r"(?:^|_)(?:id|identifiant|identifier|numero|num|code|cle|key|uuid|gid|fid)(?:_|$)", normalized):
        return "identification"
    return "other"


def _live_dataset_schema(dataset_id: str, sample_limit: int = 20) -> Dict[str, Any]:
    """Return the real API fields, never the manually entered catalogue attribute list."""
    from .local_sources import _get_dataset_config  # import différé : évite le cycle open_data_api <-> local_sources
    config = _get_dataset_config(dataset_id)
    if not config or config.get("source_type") in {"local_geojson", "local_csv", "local_gpkg", "data_gouv_auto"}:
        return {"dataset": dataset_id, "fields": [], "categories": {"location": [], "temporal": [], "identification": [], "other": []}}

    published_fields: list[str] = []
    field_labels: Dict[str, str] = {}
    metadata_error = None
    try:
        domain, slug = _parse_ods_dataset_id(dataset_id)
        meta_url = f"{_build_ods_base(domain)}/{slug}"
        meta_response = requests.get(meta_url, timeout=20)
        meta_response.raise_for_status()
        published_fields, field_labels = _extract_ods_fields_with_labels(meta_response.json())
    except Exception as exc:
        metadata_error = str(exc)

    sample_fields: list[str] = []
    sample_records: list[Dict[str, Any]] = []
    try:
        response = requests.get(config["base_url"], params={"limit": sample_limit, "offset": 0}, timeout=25)
        response.raise_for_status()
        payload = response.json()
        raw = payload.get("results") or payload.get("records") or []
        sample_records = [record for item in raw if (record := _flatten_record(item))]
        sample_fields = sorted({str(key) for record in sample_records for key in record.keys()})
    except Exception as exc:
        if not metadata_error:
            metadata_error = str(exc)

    fields = []
    for field in [*published_fields, *sample_fields]:
        if field and field not in fields:
            fields.append(field)
    categories = {"location": [], "temporal": [], "identification": [], "other": []}
    for field in fields:
        categories[_classify_attribute_name(field)].append(field)
    return {
        "dataset": dataset_id,
        "fields": fields,
        "categories": categories,
        "field_labels": field_labels,
        "sample_records": sample_records[:3],
        "source": "OpenDataSoft API",
        "warning": metadata_error,
    }



def _parse_temporal_datetime(value: Any) -> Optional[datetime]:
    """Parse common OpenDataSoft date/datetime values without inventing a date."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    # Timestamp Unix (secondes epoch), utilisé par les flux GBFS temps réel
    # (ex. last_reported, last_updated : "1784922839"). Plage 10 chiffres
    # (~2001 à ~2286) pour éviter de confondre un petit entier (capacité,
    # compteur...) avec une date.
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 1_000_000_000 <= value < 10_000_000_000:
            try:
                return datetime.fromtimestamp(value, tz=timezone.utc).replace(tzinfo=None)
            except (OverflowError, OSError, ValueError):
                pass
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"1\d{9}", text):
        try:
            return datetime.fromtimestamp(int(text), tz=timezone.utc).replace(tzinfo=None)
        except (OverflowError, OSError, ValueError):
            pass
    candidates = [text, text.replace("Z", "+00:00")]
    for candidate in candidates:
        try:
            parsed = datetime.fromisoformat(candidate)
            return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _detect_temporal_field(dataset_id: str, records: Optional[list[Dict[str, Any]]] = None) -> Optional[str]:
    """Choose a real parseable date/datetime field from the API schema and values."""
    records = records or []
    fields = []
    try:
        schema = _live_dataset_schema(dataset_id, sample_limit=20)
        fields.extend(schema.get("categories", {}).get("temporal", []))
        if not records:
            records = schema.get("sample_records", []) or []
    except Exception:
        pass
    for record in records:
        for key in record:
            if _classify_attribute_name(key) == "temporal" and key not in fields:
                fields.append(key)
    # Prefer fields with genuine sub-day time resolution (varying hour/minute
    # across the sample) over date-only helper columns: a field like
    # dd_mm_yy_utc ("28/11/2020", no time) parses successfully for every
    # record just like heure_utc does, so parsed_count alone can't tell them
    # apart — and a date-only field can never distinguish the ~96 same-day
    # readings from each other. has_time_variation is checked first, before
    # parsed_count or name-based hints, so it can't be outranked by them.
    def priority(name: str) -> tuple[bool, int, int]:
        """Attribue une priorité à un champ temporel candidat pour sélectionner le plus pertinent."""
        norm = _normalize_field_name(name)
        score = 0
        if any(token in norm for token in ("heure_utc", "datetime", "timestamp", "date_heure", "heure_de_paris")):
            score += 50
        if "date" in norm or "heure" in norm or "time" in norm:
            score += 25
        if norm in {"annee", "mois", "jour"} or norm.endswith("_annee"):
            score -= 30
        parsed_values = [
            value for record in records
            if (value := _parse_temporal_datetime(record.get(name))) is not None
        ]
        parsed_count = len(parsed_values)
        has_time_variation = len({(value.hour, value.minute) for value in parsed_values}) > 1
        return (has_time_variation, parsed_count, score)
    ranked = sorted(fields, key=priority, reverse=True)
    for field in ranked:
        parsed_values = [
            value for record in records
            if (value := _parse_temporal_datetime(record.get(field))) is not None
        ]
        if not parsed_values:
            continue
        # Un champ qui a exactement LA MÊME valeur sur toutes les lignes (ex. un
        # horodatage de rafraîchissement global d'un référentiel statique comme
        # "last_updated" sur VélÔToulouse Localisation) n'est pas une vraie
        # dimension temporelle exploitable pour un filtrage par date, même s'il
        # se parse correctement. On l'accepte seulement s'il varie réellement
        # (ou s'il n'y a qu'un seul enregistrement dans l'échantillon, auquel
        # cas la variation ne peut de toute façon pas être observée).
        if len(parsed_values) == 1 or len(set(parsed_values)) > 1:
            return field
    return None


def _detect_period_fields(dataset_id: str, records: Optional[list[Dict[str, Any]]] = None) -> Optional[tuple[str, str]]:
    """Detect a start/end date pair (e.g. date_debut / date_fin) describing a
    validity period, as opposed to a single point-in-time timestamp.

    Some datasets (road works, permits, contracts...) don't represent "one
    instant per row" but "a period per row" — trying to match them against a
    single selected date/time doesn't make sense and produced confusing
    results. This detects that shape generically from field names, for any
    dataset, so the period-range UI can be offered wherever it applies.
    """
    records = records or []
    if not records:
        try:
            schema = _live_dataset_schema(dataset_id, sample_limit=20)
            records = schema.get("sample_records", []) or []
        except Exception:
            return None
    if not records:
        return None

    field_names: set[str] = set()
    for record in records[:20]:
        field_names.update(record.keys())

    start_tokens = ("date_debut", "datedebut", "debut", "date_start", "start_date")
    end_tokens = ("date_fin", "datefin", "_fin", "date_end", "end_date")

    def norm(name: str) -> str:
        """Normalise un nom de champ pour comparer les variantes de champs temporels."""
        return _normalize_field_name(name)

    start_candidates = [f for f in field_names if any(tok in norm(f) for tok in start_tokens)]
    end_candidates = [f for f in field_names if any(tok in norm(f) for tok in end_tokens)]
    end_candidates = [f for f in end_candidates if f not in start_candidates]

    for start_field in start_candidates:
        for end_field in end_candidates:
            start_ok = any(_parse_temporal_datetime(r.get(start_field)) for r in records[:20])
            end_ok = any(_parse_temporal_datetime(r.get(end_field)) for r in records[:20])
            if start_ok and end_ok:
                return (start_field, end_field)
    return None



def _scan_period_min_max(dataset: Dict[str, Any], start_field: str, end_field: str, max_records: int = GENERIC_API_MAX_RECORDS) -> tuple[Optional[datetime], Optional[datetime]]:
    """Single-pass scan computing min(start_field) and max(end_field) across
    the dataset, without relying on order_by (see _scan_temporal_min_max)."""
    page_size = 100
    offset = 0
    first: Optional[datetime] = None
    last: Optional[datetime] = None
    while offset < max_records:
        try:
            response = requests.get(dataset["base_url"], params={"limit": page_size, "offset": offset}, timeout=25)
            response.raise_for_status()
        except requests.HTTPError:
            break
        payload = response.json()
        raw = payload.get("results") or payload.get("records") or []
        if not raw:
            break
        for item in raw:
            record = _flatten_record(item)
            if not record:
                continue
            start_value = _parse_temporal_datetime(record.get(start_field))
            if start_value is not None and (first is None or start_value < first):
                first = start_value
            end_value = _parse_temporal_datetime(record.get(end_field))
            if end_value is not None and (last is None or end_value > last):
                last = end_value
        if len(raw) < page_size:
            break
        offset += page_size
    return first, last


def _period_range_for_dataset(dataset_id: str) -> Dict[str, Any]:
    """Return whether a dataset has a start/end period pair and its overall bounds."""
    from .local_sources import _get_dataset_config  # import différé : évite le cycle open_data_api <-> local_sources
    dataset = _get_dataset_config(dataset_id)
    if not dataset:
        raise ValueError("Identifiant de dataset invalide")

    schema = _live_dataset_schema(dataset_id, sample_limit=50)
    sample_records = schema.get("sample_records") or []
    period_fields = _detect_period_fields(dataset_id, sample_records)
    if not period_fields:
        return {"dataset": dataset_id, "period_available": False, "start_field": None, "end_field": None}
    start_field, end_field = period_fields

    first, last = _scan_period_min_max(dataset, start_field, end_field)
    if first is None or last is None:
        return {"dataset": dataset_id, "period_available": False, "start_field": start_field, "end_field": end_field}

    return {
        "dataset": dataset_id,
        "period_available": True,
        "start_field": start_field,
        "end_field": end_field,
        "min_date": first.date().isoformat(),
        "max_date": last.date().isoformat(),
    }


def _fetch_records_active_in_period(
    dataset_id: str,
    dataset: Dict[str, Any],
    start_field: str,
    end_field: str,
    range_start: Optional[datetime],
    range_end: Optional[datetime],
) -> tuple[list[Dict[str, Any]], Dict[str, Any]]:
    """Return the records whose [start_field, end_field] period overlaps the
    requested [range_start, range_end] window (either bound can be open).

    Uses the same defensive strategy learned from the point-in-time case:
    try documented ODSQL comparison syntaxes first, and only fall back to a
    bounded local scan if every server-side filter is rejected.
    """
    where_parts = []
    if range_end is not None:
        where_parts.append((start_field, "<=", range_end))
    if range_start is not None:
        where_parts.append((end_field, ">=", range_start))

    def build_where(literal_fn) -> str:
        """Construit la clause de filtrage OpenDataSoft correspondant à une période donnée."""
        clauses = [f"{field} {op} {literal_fn(value)}" for field, op, value in where_parts]
        return " AND ".join(clauses)

    where_candidates = []
    if where_parts:
        where_candidates.append(build_where(_ods_date_literal))
        where_candidates.append(build_where(lambda v: f'"{v.date().isoformat()}"'))

    raw: list[Any] = []
    where_used = None
    rejected_filters = []
    for where in dict.fromkeys(where_candidates):
        try:
            raw, _, _, _, _ = _fetch_paginated_records(
                dataset["base_url"],
                extra_params={"where": where},
                max_records=GENERIC_API_MAX_RECORDS,
            )
            where_used = where
            break
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            rejected_filters.append({"where": where, "status": status})
            if status not in (400, 422):
                raise

    if where_used is None and where_parts:
        # Every filtered request failed: fall back to a bounded local scan.
        raw = []
        offset = 0
        page_size = 100
        while offset < GENERIC_API_MAX_RECORDS:
            try:
                response = requests.get(dataset["base_url"], params={"limit": page_size, "offset": offset}, timeout=25)
                response.raise_for_status()
            except requests.HTTPError:
                break
            payload = response.json()
            page = payload.get("results") or payload.get("records") or []
            if not page:
                break
            raw.extend(page)
            if len(page) < page_size:
                break
            offset += page_size

    records = [record for item in raw if (record := _flatten_record(item))]
    active = []
    for record in records:
        start_value = _parse_temporal_datetime(record.get(start_field))
        end_value = _parse_temporal_datetime(record.get(end_field))
        if range_end is not None and start_value is not None and start_value > range_end:
            continue
        if range_start is not None and end_value is not None and end_value < range_start:
            continue
        active.append(record)

    info = {
        "period_field": {"start": start_field, "end": end_field},
        "range_start": range_start.date().isoformat() if range_start else None,
        "range_end": range_end.date().isoformat() if range_end else None,
        "records_matched": len(active),
        "where": where_used,
        "rejected_filters": rejected_filters,
    }
    return active, info



def _scan_temporal_min_max(dataset: Dict[str, Any], temporal_field: str, max_records: int = GENERIC_API_MAX_RECORDS) -> tuple[Optional[datetime], Optional[datetime]]:
    """Compute the true min/max of a temporal field by scanning records page by
    page, without relying on order_by. order_by can silently misbehave on
    fields that aren't a genuinely sortable type (e.g. plain text without the
    "sortable" annotation), so this is the fallback used whenever the
    order_by-based edges can't be confirmed to have real data."""
    page_size = 100
    offset = 0
    first: Optional[datetime] = None
    last: Optional[datetime] = None
    while offset < max_records:
        try:
            response = requests.get(dataset["base_url"], params={"limit": page_size, "offset": offset}, timeout=25)
            response.raise_for_status()
        except requests.HTTPError:
            break
        payload = response.json()
        raw = payload.get("results") or payload.get("records") or []
        if not raw:
            break
        for item in raw:
            record = _flatten_record(item)
            if not record:
                continue
            parsed = _parse_temporal_datetime(record.get(temporal_field))
            if parsed is None:
                continue
            if first is None or parsed < first:
                first = parsed
            if last is None or parsed > last:
                last = parsed
        if len(raw) < page_size:
            break
        offset += page_size
    return first, last


def _temporal_range_for_dataset(dataset_id: str) -> Dict[str, Any]:
    """Return the real temporal field and its first/last available values.

    OpenDataSoft datasets are queried with one ascending and one descending
    record, so the result is dataset-specific and does not depend on a fixed
    year or on the first page loaded for the map. Local/Data.gouv GeoJSON
    resources are inspected directly.
    """
    from .local_sources import _get_dataset_config, _local_geojson_to_response  # import différé : évite le cycle open_data_api <-> local_sources
    dataset = _get_dataset_config(dataset_id)
    if not dataset:
        raise ValueError("Identifiant de dataset invalide")

    source_type = dataset.get("source_type")
    records: list[Dict[str, Any]] = []

    if source_type == "local_geojson":
        payload = _local_geojson_to_response(dataset_id, dataset)
        records = [feature.get("properties") or {} for feature in payload.get("features", [])]
    elif source_type == "data_gouv_auto":
        payload = _load_data_gouv_geojson(dataset_id, dataset)
        records = [feature.get("properties") or {} for feature in payload.get("features", [])]
    elif source_type == "local_csv":
        # Pas de champ temporel pertinent pour ces fichiers (recensement annuel).
        return {"dataset": dataset_id, "temporal_available": False, "temporal_field": None}
    elif source_type == "local_gpkg":
        # Référentiel géographique statique (contours), pas de champ temporel.
        return {"dataset": dataset_id, "temporal_available": False, "temporal_field": None}

    if records:
        temporal_field = _detect_temporal_field(dataset_id, records[:200])
        if not temporal_field:
            return {"dataset": dataset_id, "temporal_available": False, "temporal_field": None}
        parsed = [_parse_temporal_datetime(record.get(temporal_field)) for record in records]
        parsed = [value for value in parsed if value is not None]
        if not parsed:
            return {"dataset": dataset_id, "temporal_available": False, "temporal_field": temporal_field}
        first, last = min(parsed), max(parsed)
    else:
        # Important : on ne réutilise PAS schema["sample_records"] ici — ce
        # champ est volontairement tronqué à 3 lignes par _live_dataset_schema
        # (prévu pour un aperçu léger ailleurs). Avec seulement 3 lignes, il
        # suffit qu'elles partagent par malchance la même valeur (regroupement
        # par horodatage plutôt que par entité dans certains datasets) pour
        # que la détection de variation échoue à tort. On récupère donc notre
        # propre échantillon de taille normale, comme le font déjà les autres
        # points du code qui détectent un champ temporel.
        try:
            sample_response = requests.get(dataset["base_url"], params={"limit": 100, "offset": 0}, timeout=25)
            sample_response.raise_for_status()
            sample_payload = sample_response.json()
            sample_raw = sample_payload.get("results") or sample_payload.get("records") or []
            detection_sample = [record for item in sample_raw if (record := _flatten_record(item))]
        except Exception:
            detection_sample = []
        temporal_field = _detect_temporal_field(dataset_id, detection_sample)
        if not temporal_field:
            return {"dataset": dataset_id, "temporal_available": False, "temporal_field": None}

        def fetch_edge(direction: str) -> Optional[datetime]:
            """Récupère l'une des bornes temporelles du jeu selon l'ordre de tri demandé."""
            response = requests.get(
                dataset["base_url"],
                params={
                    "limit": 1,
                    "offset": 0,
                    "order_by": f"{temporal_field} {direction}",
                    "where": f"{temporal_field} is not null",
                },
                timeout=25,
            )
            response.raise_for_status()
            payload = response.json()
            raw = payload.get("results") or payload.get("records") or []
            for item in raw:
                record = _flatten_record(item)
                parsed = _parse_temporal_datetime(record.get(temporal_field))
                if parsed:
                    return parsed
            return None

        first = fetch_edge("ASC")
        last = fetch_edge("DESC")
        if first is None or last is None:
            # Fallback for APIs that reject a SQL-like null condition.
            response = requests.get(dataset["base_url"], params={"limit": 100, "offset": 0}, timeout=25)
            response.raise_for_status()
            payload = response.json()
            sample = [_flatten_record(item) for item in (payload.get("results") or payload.get("records") or [])]
            parsed = [_parse_temporal_datetime(record.get(temporal_field)) for record in sample]
            parsed = [value for value in parsed if value is not None]
            if not parsed:
                return {"dataset": dataset_id, "temporal_available": False, "temporal_field": temporal_field}
            first = first or min(parsed)
            last = last or max(parsed)
        else:
            # order_by can silently misbehave on fields that aren't a
            # genuinely sortable type (e.g. plain text without the
            # "sortable" annotation), returning an arbitrary record instead of
            # the true earliest/latest — which then surfaces as a calendar
            # bound with no data actually available on it. Confirm the
            # reported edges against real, retrievable data before trusting
            # them; if either fails, recompute both via a direct scan. This
            # rule applies to every dataset uniformly, not just specific ones.
            edges_confirmed = True
            for candidate in (first, last):
                try:
                    validation_records, _ = _fetch_temporal_day_records(dataset_id, dataset, temporal_field, candidate)
                except Exception:
                    validation_records = []
                if not validation_records:
                    edges_confirmed = False
                    break
            if not edges_confirmed:
                scanned_first, scanned_last = _scan_temporal_min_max(dataset, temporal_field)
                if scanned_first and scanned_last:
                    first, last = scanned_first, scanned_last

    return {
        "dataset": dataset_id,
        "temporal_available": True,
        "temporal_field": temporal_field,
        "min_datetime": first.isoformat(timespec="minutes"),
        "max_datetime": last.isoformat(timespec="minutes"),
        "min_date": first.date().isoformat(),
        "max_date": last.date().isoformat(),
    }

def _selected_datetime_args() -> tuple[Optional[str], Optional[str], Optional[datetime], bool]:
    """Lit et valide les paramètres de date et d'heure transmis à la requête courante."""
    date_str = (request.args.get("date") or "").strip()
    time_str = (request.args.get("time") or request.args.get("hour") or "").strip()
    if time_str and re.fullmatch(r"\d{1,2}", time_str):
        time_str = f"{int(time_str):02d}:00"
    if not date_str:
        return None, time_str or None, None, False
    hour_specified = bool(time_str)
    if not time_str:
        time_str = "00:00"
    try:
        selected = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
    except ValueError:
        raise ValueError("La date ou l’heure est invalide. Format attendu : AAAA-MM-JJ et HH:MM.")
    return date_str, time_str, selected, hour_specified


def _filter_records_same_date_nearest_time(
    records: list[Dict[str, Any]], temporal_field: str, selected: datetime, *,
    restrict_to_selected_date: bool = True, hour_specified: bool = True,
) -> tuple[list[Dict[str, Any]], Dict[str, Any]]:
    """Exact minute first, otherwise nearest minute in the supplied day window.

    When hour_specified is False, no minute-level matching is done at all :
    every record for the selected date is returned (any hour), since the
    person didn't ask to narrow it down to one specific moment."""
    dated = []
    for record in records:
        parsed = _parse_temporal_datetime(record.get(temporal_field))
        if parsed and (not restrict_to_selected_date or parsed.date() == selected.date()):
            dated.append((record, parsed))
    if not dated:
        return [], {
            "temporal_field": temporal_field,
            "requested_datetime": selected.isoformat(timespec="minutes"),
            "match_type": "no_data_for_date",
        }
    if not hour_specified:
        return [record for record, _ in dated], {
            "temporal_field": temporal_field,
            "requested_datetime": selected.isoformat(timespec="minutes"),
            "match_type": "all_day",
            "same_date_records": len(dated),
        }
    exact = [(record, parsed) for record, parsed in dated if parsed.hour == selected.hour and parsed.minute == selected.minute]
    if exact:
        chosen_dt = exact[0][1].replace(second=0, microsecond=0)
        selected_records = [record for record, parsed in exact if parsed.replace(second=0, microsecond=0) == chosen_dt]
        match_type = "exact"
    else:
        chosen_dt = min((parsed for _, parsed in dated), key=lambda dt: abs((dt - selected).total_seconds()))
        chosen_minute = chosen_dt.replace(second=0, microsecond=0)
        selected_records = [record for record, parsed in dated if parsed.replace(second=0, microsecond=0) == chosen_minute]
        match_type = "nearest_same_date"
    return selected_records, {
        "temporal_field": temporal_field,
        "requested_datetime": selected.isoformat(timespec="minutes"),
        "selected_datetime": chosen_dt.isoformat(timespec="minutes"),
        "match_type": match_type,
        "same_date_records": len(dated),
    }


def _is_utc_temporal_field(field_name: str) -> bool:
    """Détermine si un champ temporel doit être interprété en UTC."""
    normalized = _normalize_field_name(field_name)
    return "utc" in normalized or normalized.endswith("_z")


def _ods_date_literal(value: datetime) -> str:
    """Return a valid OpenDataSoft Explore v2 date literal (documented ODSQL syntax: date'ISO8601')."""
    return f"date'{value.isoformat(timespec='seconds')}'"


def _temporal_query_window(temporal_field: str, selected_local: datetime) -> tuple[datetime, datetime, datetime]:
    """Build the source-field day window and comparison time.

    The date and time entered in the interface are interpreted in Europe/Paris.
    For UTC fields (for example ``heure_utc``), the local day boundaries and the
    requested instant are converted to UTC before querying/comparing. This keeps
    10:15 Paris aligned with 09:15 UTC in winter and 08:15 UTC in summer.
    """
    if not _is_utc_temporal_field(temporal_field):
        start = datetime.combine(selected_local.date(), datetime.min.time())
        return start, start + timedelta(days=1), selected_local

    paris = ZoneInfo("Europe/Paris")
    start_local = datetime.combine(selected_local.date(), datetime.min.time(), tzinfo=paris)
    end_local = start_local + timedelta(days=1)
    requested_local = selected_local.replace(tzinfo=paris)
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)
    requested_utc = requested_local.astimezone(timezone.utc)
    # _parse_temporal_datetime deliberately returns naive values; use naive UTC
    # here as well so comparisons remain consistent.
    return (
        start_utc.replace(tzinfo=None),
        end_utc.replace(tzinfo=None),
        requested_utc.replace(tzinfo=None),
    )


def _date_prefix_format(sample_value: Any) -> str:
    """Detect the day-portion string format actually used by a temporal field.

    startswith() prefix matching only works if the prefix is built in the same
    format the field's real values use. Assuming ISO order unconditionally
    broke on a field formatted DD/MM/YYYY (e.g. dd_mm_yy_utc: "28/11/2020").
    """
    text = str(sample_value or "").strip()
    if re.match(r"^\d{4}-\d{1,2}-\d{1,2}", text):
        return "%Y-%m-%d"
    if re.match(r"^\d{1,2}/\d{1,2}/\d{4}", text):
        return "%d/%m/%Y"
    return "%Y-%m-%d"


def _fetch_temporal_day_records(dataset_id: str, dataset: Dict[str, Any], temporal_field: str, selected: datetime, sample_value: Any = None, hour_specified: bool = True) -> tuple[list[Dict[str, Any]], Dict[str, Any]]:
    """Fetch the selected Paris day and select the exact/nearest minute.

    OpenDataSoft's ODSQL reference documents a single valid date/datetime
    literal syntax: ``date'ISO8601'`` (see the Where clause / Date comparison
    operators sections of the Explore API v2.1 docs). We try that form first,
    then a couple of more lenient variants some deployments also accept, and
    only when every filtered request is rejected by the API do we fall back to
    a bounded, ordered scan. This prevents a valid date from being reported as
    unavailable just because of a query-syntax mismatch.
    """
    start, end, comparison_selected = _temporal_query_window(temporal_field, selected)

    def quoted(value: datetime, include_utc_offset: bool = False) -> str:
        """Formate une date entre guillemets pour son insertion dans une clause de requête."""
        text = value.isoformat(timespec="seconds")
        if include_utc_offset and _is_utc_temporal_field(temporal_field):
            text += "+00:00"
        return f'"{text}"'

    day_strs_iso = sorted({start.date().isoformat(), (end - timedelta(seconds=1)).date().isoformat()})
    day_prefix_format = _date_prefix_format(sample_value)
    day_strs_raw = sorted({
        start.date().strftime(day_prefix_format),
        (end - timedelta(seconds=1)).date().strftime(day_prefix_format),
    })

    def date_format_equality(field_expr: str) -> str:
        """Construit une condition comparant un champ temporel à une date formatée."""
        clauses = [f"date_format({field_expr}, 'yyyy-MM-dd') = '{day}'" for day in day_strs_iso]
        return " OR ".join(clauses) if len(clauses) == 1 else "(" + " OR ".join(clauses) + ")"

    def startswith_equality(field_expr: str) -> str:
        """Construit une condition de préfixe pour les champs temporels stockés comme texte."""
        clauses = [f'startswith({field_expr}, "{day}")' for day in day_strs_raw]
        return " OR ".join(clauses) if len(clauses) == 1 else "(" + " OR ".join(clauses) + ")"

    where_candidates = [
        # Some OpenDataSoft datasets store their temporal field as plain TEXT
        # (an ISO8601-formatted string) rather than a real date/datetime type.
        # On a text field, only equality/text predicates are valid — range
        # comparisons (>=, <) and date_format() are rejected outright with
        # IncompatibleTypesInComparisonFilter / "must be a date field" errors.
        # startswith() on the day prefix works for that case and is tried first.
        f"{startswith_equality(temporal_field)}",
        f"{startswith_equality(f'`{temporal_field}`')}",
        # Documented ODSQL syntax (Explore API v2.1 reference): date'ISO8601'.
        f"{temporal_field} >= {_ods_date_literal(start)} AND {temporal_field} < {_ods_date_literal(end)}",
        # Equality on just the date part via date_format(): sidesteps any
        # restriction specific to range (>=, <) comparisons. Covers both
        # calendar days the Paris day window can straddle once converted to UTC.
        f"{date_format_equality(temporal_field)}",
        f"{date_format_equality(f'`{temporal_field}`')}",
        # Same, with backtick-quoted field name (reserved words, mixed case, accents).
        f"`{temporal_field}` >= {_ods_date_literal(start)} AND `{temporal_field}` < {_ods_date_literal(end)}",
        # Syntax used historically by Toulouse OpenDataSoft Explore v2.1.
        f"{temporal_field} >= {quoted(start, True)} AND {temporal_field} < {quoted(end, True)}",
        # Some datasets expose naive datetime values even when the field is UTC.
        f"{temporal_field} >= {quoted(start)} AND {temporal_field} < {quoted(end)}",
        f"`{temporal_field}` >= {quoted(start, True)} AND `{temporal_field}` < {quoted(end, True)}",
        f"`{temporal_field}` >= {quoted(start)} AND `{temporal_field}` < {quoted(end)}",
    ]

    raw = []
    total = None
    first_url = None
    pages = 0
    truncated = False
    where_used = None
    rejected_filters = []
    best_empty_result: Optional[tuple[list, Optional[int], Optional[str], int, bool, str]] = None

    for where in dict.fromkeys(where_candidates):
        try:
            candidate_raw, candidate_total, candidate_url, candidate_pages, candidate_truncated = _fetch_paginated_records(
                dataset["base_url"],
                # No order_by here: sorting is only valid on numeric/date fields
                # or on text fields explicitly marked "sortable". Some temporal
                # fields (confirmed for at least one dataset) are plain text
                # without that annotation, so requesting an order_by would make
                # the WHOLE request fail with 400 even when the where clause
                # itself is perfectly valid. Order doesn't matter here anyway:
                # the exact/nearest-time match is computed locally afterwards.
                extra_params={"where": where},
                max_records=GENERIC_API_MAX_RECORDS,
            )
            if candidate_raw:
                # Found actual matching rows: this syntax is correct for this
                # dataset, stop here.
                raw, total, first_url, pages, truncated = candidate_raw, candidate_total, candidate_url, candidate_pages, candidate_truncated
                where_used = where
                break
            # Syntactically accepted but zero matches: could be a genuinely
            # data-free day, or a subtly wrong (but not rejected) comparison.
            # Remember it and keep trying other syntaxes before concluding.
            if best_empty_result is None:
                best_empty_result = (candidate_raw, candidate_total, candidate_url, candidate_pages, candidate_truncated, where)
        except requests.HTTPError as exc:
            # A malformed/unsupported where clause is generally returned as 400.
            # Try the next known ODS syntax; propagate authentication/server errors.
            status = exc.response.status_code if exc.response is not None else None
            rejected_filters.append({"where": where, "status": status})
            if status not in {400, 422}:
                raise

    fallback_full_scan = False
    if where_used is None and best_empty_result is not None:
        # Every candidate that the API accepted returned zero rows. Trust
        # that over an expensive full scan: it means the requested day
        # genuinely has no data for this field.
        raw, total, first_url, pages, truncated, where_used = best_empty_result
    elif where_used is None:
        # Last-resort correctness path: no temporal where clause worked on this
        # API. Fetching the whole dataset unbounded (which can be hundreds of
        # thousands of rows for a multi-year weather station) is what used to
        # make a perfectly valid, existing date time out client-side after 60s.
        # Instead, page through the data ordered by the temporal field and stop
        # as soon as we've moved past the requested day: since the API returns
        # records in ascending temporal order, once a whole page is already
        # later than `end` there is nothing more to find.
        fallback_full_scan = True
        page_size = 100
        offset = 0
        raw = []
        total = None
        first_url = None
        pages = 0
        truncated = False
        max_pages = 90  # hard safety net: offset+limit must stay under the API's 10 000 cap
        use_order_by = True
        while pages < max_pages:
            page_params = {"limit": page_size, "offset": offset}
            if use_order_by:
                page_params["order_by"] = f"{temporal_field} ASC"
            try:
                page_response = requests.get(dataset["base_url"], params=page_params, timeout=25)
                page_response.raise_for_status()
            except requests.HTTPError as exc:
                status = exc.response.status_code if exc.response is not None else None
                if use_order_by and status in {400, 422} and offset == 0:
                    # Sorting isn't supported on this field (e.g. a text field
                    # without the "sortable" annotation): retry without it.
                    # We lose the ascending-order early-exit optimization, but
                    # the page cap above still keeps this bounded and fast.
                    use_order_by = False
                    continue
                raise
            page_payload = page_response.json()
            if first_url is None:
                first_url = page_response.url
            if total is None:
                total = page_payload.get("total_count")
            page_results = page_payload.get("results") or page_payload.get("records") or []
            if not isinstance(page_results, list):
                page_results = []
            pages += 1
            if not page_results:
                break
            raw.extend(page_results)
            page_dates = [
                parsed
                for item in page_results
                if (record := _flatten_record(item)) and (parsed := _parse_temporal_datetime(record.get(temporal_field)))
            ]
            if use_order_by and page_dates and min(page_dates) >= end:
                # Ascending order: every subsequent page will be even later.
                break
            if len(page_results) < page_size:
                break
            if total is not None and offset + len(page_results) >= int(total):
                break
            offset += page_size
        if pages >= max_pages:
            truncated = True

    records = [record for item in raw if (record := _flatten_record(item))]
    # Whether the API returned one day or the whole dataset, enforce the Paris
    # day window locally. For UTC fields, start/end are already converted to UTC.
    day_records = []
    for record in records:
        parsed = _parse_temporal_datetime(record.get(temporal_field))
        if parsed is not None and start <= parsed < end:
            day_records.append(record)

    filtered, info = _filter_records_same_date_nearest_time(
        day_records, temporal_field, comparison_selected, restrict_to_selected_date=False, hour_specified=hour_specified
    )
    info.update({
        "where": where_used,
        "requested_local_datetime": selected.isoformat(timespec="minutes"),
        "comparison_datetime_in_source_field": comparison_selected.isoformat(timespec="minutes"),
        "timezone_interpretation": "Europe/Paris",
        "records_for_date": len(day_records),
        "total_api_for_query": total,
        "source_url": first_url,
        "pages_loaded": pages,
        "truncated": truncated,
        "fallback_full_scan": fallback_full_scan,
        "rejected_temporal_filters": rejected_filters,
    })
    return filtered, info


COUNT_FIELDS = {
    "all": "Tous",
    "pedestrian_count": "Piétons",
    "bike_count": "Vélos",
    "car_count": "Voitures",
    "heavy_vehicle_count": "Poids lourds",
}


def _is_number(value: Any) -> bool:
    """Vérifie qu'une valeur peut être interprétée comme un nombre exploitable."""
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def _parse_json_if_needed(value: Any) -> Any:
    """Décode une chaîne JSON lorsque la valeur reçue est sérialisée."""
    if isinstance(value, str):
        text = value.strip()
        if (text.startswith("{") and text.endswith("}")) or (text.startswith("[") and text.endswith("]")):
            try:
                return json.loads(text)
            except ValueError:
                return value
    return value


def _point_from_value(value: Any) -> Optional[Tuple[float, float]]:
    """Return (lon, lat) from common OpenDataSoft coordinate shapes."""
    value = _parse_json_if_needed(value)
    if isinstance(value, dict):
        lat = value.get("lat") or value.get("latitude") or value.get("y")
        lon = value.get("lon") or value.get("lng") or value.get("longitude") or value.get("x")
        if _is_number(lat) and _is_number(lon):
            return float(lon), float(lat)
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        a, b = value[0], value[1]
        if _is_number(a) and _is_number(b):
            a, b = float(a), float(b)
            # OpenDataSoft point arrays are often [lat, lon]. GeoJSON wants [lon, lat].
            if -90 <= a <= 90 and -180 <= b <= 180:
                return b, a
            return a, b
    return None


def _wkt_to_geojson_geometry(value: Any) -> Optional[Dict[str, Any]]:
    """Convert WKT/EWKT text to a Leaflet-ready GeoJSON geometry.

    Handles values such as ``POINT(...)`` and
    ``SRID=3857;POLYGON((...))``. When no SRID is declared but the
    coordinates are clearly outside longitude/latitude ranges, EPSG:3857
    is inferred.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None

    match = re.match(r"^SRID\s*=\s*(\d+)\s*;\s*(.+)$", text, re.I | re.S)
    srid = int(match.group(1)) if match else None
    wkt_text = match.group(2).strip() if match else text
    if not re.match(
        r"^(?:POINT|MULTIPOINT|LINESTRING|MULTILINESTRING|POLYGON|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*(?:Z|M|ZM)?\s*\(",
        wkt_text,
        re.I,
    ):
        return None

    try:
        from shapely import wkt as shapely_wkt  # type: ignore
        from shapely.geometry import mapping  # type: ignore
        geometry = shapely_wkt.loads(wkt_text)
        if geometry.is_empty:
            return None

        if srid is None:
            minx, miny, maxx, maxy = geometry.bounds
            if any(abs(v) > limit for v, limit in ((minx, 180), (maxx, 180), (miny, 90), (maxy, 90))):
                srid = 3857

        if srid and srid != 4326:
            from pyproj import Transformer  # type: ignore
            from shapely.ops import transform as shapely_transform  # type: ignore
            transformer = Transformer.from_crs(f"EPSG:{srid}", "EPSG:4326", always_xy=True)
            geometry = shapely_transform(transformer.transform, geometry)

        return dict(mapping(geometry))
    except Exception:
        return None


def _as_geojson_geometry(value: Any) -> Optional[Dict[str, Any]]:
    """Normalize GeoJSON, OpenDataSoft geometry values and WKT/EWKT."""
    wkt_geometry = _wkt_to_geojson_geometry(value)
    if wkt_geometry:
        return wkt_geometry

    value = _parse_json_if_needed(value)
    if not isinstance(value, dict):
        return None

    value_type = value.get("type")

    if value_type == "Feature" and isinstance(value.get("geometry"), dict):
        return _as_geojson_geometry(value["geometry"])

    if isinstance(value.get("geometry"), dict):
        return _as_geojson_geometry(value["geometry"])

    if value_type in {
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
        "GeometryCollection",
    }:
        if value_type == "GeometryCollection" and isinstance(value.get("geometries"), list):
            return value
        if value.get("coordinates") is not None:
            return value

    return None


def _geometry_from_record(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    # 1) Prefer explicit geometry fields. WKT/EWKT is supported as well.
    """Détecte et extrait la géométrie présente dans un enregistrement."""
    geometry_keys = (
        "geo_shape",
        "geoshape",
        "geo_shape_2d",
        "shape",
        "geometry",
        "the_geom",
        "geom",
        "wkt",
        "osm_original_geom",
    )
    checked = set()
    for key in geometry_keys:
        checked.add(key)
        geometry = _as_geojson_geometry(record.get(key))
        if geometry:
            return geometry

    # 1b) Generic discovery: field names can differ across publishers.
    # Examples: building_geometry, original_wkt, osm_original_geom.
    for key, value in record.items():
        normalized_key = _normalize_field_name(key)
        if key in checked or not re.search(r"(?:^|_)(?:geom(?:etry)?|shape|wkt)(?:_|$)", normalized_key):
            continue
        geometry = _as_geojson_geometry(value)
        if geometry:
            return geometry

    # 1c) Last WKT safety net: inspect values even when the column name is opaque.
    for value in record.values():
        geometry = _wkt_to_geojson_geometry(value)
        if geometry:
            return geometry

    # 2) Then fall back to OpenDataSoft point fields only if no geoshape exists.
    preferred_point_keys = (
        "geo_point_2d",
        "geopoint",
        "geo_point",
        "coordonnees",
        "coordinates",
        "localisation",
    )
    for key in preferred_point_keys:
        point = _point_from_value(record.get(key))
        if point:
            return {"type": "Point", "coordinates": list(point)}

    # 3) Any dict/list containing lat/lon.
    for value in record.values():
        point = _point_from_value(value)
        if point:
            return {"type": "Point", "coordinates": list(point)}

    # 4) Separate latitude / longitude columns.
    lat_keys = ["lat", "latitude", "y"]
    lon_keys = ["lon", "lng", "longitude", "x"]
    for lat_key in lat_keys:
        for lon_key in lon_keys:
            if _is_number(record.get(lat_key)) and _is_number(record.get(lon_key)):
                return {"type": "Point", "coordinates": [float(record[lon_key]), float(record[lat_key])]}
    return None


def _normalize_field_name(value: Any) -> str:
    """Normalise un nom de champ pour les comparaisons internes."""
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def _flatten_record(item: Any) -> Optional[Dict[str, Any]]:
    """Aplati la structure d'un enregistrement API pour obtenir un dictionnaire de propriétés homogène."""
    if not isinstance(item, dict):
        return None
    fields = item.get("fields")
    return fields if isinstance(fields, dict) else item


def _field_profile(records: list[Dict[str, Any]], field: str) -> Dict[str, Any]:
    """Construit le profil statistique et sémantique d'un champ."""
    values = []
    for record in records[:200]:
        value = record.get(field)
        if value not in (None, ""):
            values.append(str(value).strip())
    distinct = set(values)
    return {
        "field": field,
        "filled": len(values),
        "distinct": len(distinct),
        "uniqueness_ratio": round(len(distinct) / len(values), 3) if values else 0.0,
        "examples": list(distinct)[:5],
    }


def _metric_value_for_record(record: Dict[str, Any], selected_metric: str) -> float:
    """Return the value used for styling/statistics.

    If selected_metric == "all", the value is the sum of all count fields
    available in the record: piétons + vélos + voitures + poids lourds.
    """
    if selected_metric == "all":
        total = 0.0
        for key in ("pedestrian_count", "bike_count", "car_count", "heavy_vehicle_count"):
            if _is_number(record.get(key)):
                total += float(record.get(key))
        return total

    if _is_number(record.get(selected_metric)):
        return float(record.get(selected_metric))
    return 0.0


def _records_to_geojson(payload: Dict[str, Any], selected_metric: Optional[str]) -> Dict[str, Any]:
    """Convertit les enregistrements de l'API en FeatureCollection GeoJSON."""
    results = payload.get("results") or payload.get("records") or []
    features = []
    total_metric = 0.0
    max_metric = 0.0

    for item in results:
        # API v2.1: item is already a flat record in results.
        # API v2: item can contain a "fields" object.
        record = item.get("fields") if isinstance(item, dict) and isinstance(item.get("fields"), dict) else item
        if not isinstance(record, dict):
            continue

        geometry = _geometry_from_record(record)
        if not geometry:
            continue

        properties = {
            k: v
            for k, v in record.items()
            if k not in {"geo_shape", "geoshape", "geometry", "the_geom", "geom"}
        }

        if selected_metric is not None:
            metric_value = _metric_value_for_record(record, selected_metric)
            total_metric += metric_value
            max_metric = max(max_metric, metric_value)
            properties["_selected_metric"] = selected_metric
            properties["_selected_metric_label"] = COUNT_FIELDS.get(selected_metric, selected_metric)
            properties["_selected_metric_value"] = metric_value
            if selected_metric == "all":
                properties["total_count_all"] = metric_value

        features.append({"type": "Feature", "geometry": geometry, "properties": properties})

    metric_total = None if selected_metric is None else (int(total_metric) if total_metric.is_integer() else total_metric)
    metric_max = None if selected_metric is None else (int(max_metric) if max_metric.is_integer() else max_metric)

    return {
        "type": "FeatureCollection",
        "features": features,
        "computed": {
            "metric": selected_metric,
            "metric_label": COUNT_FIELDS.get(selected_metric, selected_metric) if selected_metric is not None else "Sans comptage",
            "metric_total": metric_total,
            "metric_max": metric_max,
        },
    }



def _fetch_paginated_records(
    base_url: str,
    *,
    extra_params: Optional[Dict[str, Any]] = None,
    max_records: Optional[int] = None,
) -> Tuple[list, Optional[int], Optional[str], int, bool]:
    """Fetch an OpenDataSoft records endpoint with automatic pagination."""
    page_size = 100
    offset = 0
    all_results = []
    total_api = None
    first_url = None
    pages_loaded = 0
    truncated = False

    while True:
        params: Dict[str, Any] = {"limit": page_size, "offset": offset}
        if extra_params:
            params.update(extra_params)

        response = requests.get(base_url, params=params, timeout=25)
        response.raise_for_status()
        payload = response.json()

        if first_url is None:
            first_url = response.url
        if total_api is None:
            total_api = payload.get("total_count")

        page_results = payload.get("results") or payload.get("records") or []
        if not isinstance(page_results, list):
            page_results = []

        if max_records is not None:
            remaining = max_records - len(all_results)
            if remaining <= 0:
                truncated = True
                break
            all_results.extend(page_results[:remaining])
            if len(page_results) > remaining:
                truncated = True
                break
        else:
            all_results.extend(page_results)

        pages_loaded += 1

        if not page_results:
            break
        if total_api is not None and len(all_results) >= int(total_api):
            break
        if len(page_results) < page_size:
            break
        if max_records is not None and len(all_results) >= max_records:
            truncated = total_api is None or len(all_results) < int(total_api)
            break

        offset += page_size

    return all_results, total_api, first_url, pages_loaded, truncated

def _parse_date_hour(date_str: Optional[str], hour_str: Optional[str]) -> Tuple[str, int, datetime, datetime]:
    """Convertit les paramètres de date et d'heure en bornes temporelles utilisables par l'API."""
    if not date_str:
        date_str = "2025-01-01"
    try:
        hour = int(hour_str) if hour_str is not None and str(hour_str).strip() != "" else 1
    except ValueError:
        hour = 1
    hour = max(0, min(23, hour))
    start = datetime.strptime(f"{date_str} {hour:02d}:00", "%Y-%m-%d %H:%M")
    end = start + timedelta(hours=1)
    return date_str, hour, start, end


def _data_gouv_metadata_summary(dataset: Dict[str, Any]) -> Tuple[Dict[str, Any], list[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Résume les métadonnées et ressources d'un jeu publié sur data.gouv.fr."""
    identifier = str(dataset.get("data_gouv_identifier") or "")
    metadata = DATA_GOUV_CONNECTOR.fetch_metadata(identifier)
    resources = DATA_GOUV_CONNECTOR.rank_resources(metadata.get("resources") or [])
    best = resources[0] if resources else None
    return metadata, resources, best


def _load_data_gouv_geojson(dataset_id: str, dataset: Dict[str, Any]) -> Dict[str, Any]:
    """Télécharge et charge la ressource géographique pertinente d'un jeu data.gouv.fr."""
    metadata, resources, best = _data_gouv_metadata_summary(dataset)
    if not best:
        raise DataGouvConnectorError(
            "Aucune ressource GeoJSON, GeoPackage, Shapefile, CSV ou JSON exploitable n’a été trouvée."
        )
    geojson, connector_meta = DATA_GOUV_CONNECTOR.load_first_spatial_resource(
        str(dataset.get("data_gouv_identifier") or ""),
        resources,
        records_to_geojson=_records_to_geojson,
    )
    features = geojson.get("features") or []
    geometry_types = sorted({
        feature.get("geometry", {}).get("type", "Non renseigné")
        for feature in features if isinstance(feature, dict)
    })
    geojson.setdefault("computed", {
        "metric": None, "metric_label": "Sans comptage",
        "metric_total": None, "metric_max": None,
    })
    geojson["metadata"] = {
        "dataset": dataset_id,
        "title": request.args.get("title", "").strip() or metadata.get("title") or dataset.get("title"),
        "source_type": "data_gouv_auto",
        "data_gouv_id": metadata.get("id"),
        "data_gouv_slug": metadata.get("slug"),
        "data_gouv_page": metadata.get("page"),
        "features_displayed": len(features),
        "records_loaded": len(features),
        "geometry_types": geometry_types,
        "resource_candidates": len(resources),
        **connector_meta,
    }
    return geojson


def _fetch_latest_per_location(
    base_url: str, temporal_field: str, max_records: int, page_size: int = 100, max_workers: int = 10
) -> Tuple[list, Optional[int], Optional[str], int, bool]:
    """Parcourt jusqu'à max_records enregistrements, triés par champ temporel
    décroissant, et garde, pour chaque POINT GÉOGRAPHIQUE DISTINCT
    (coordonnées arrondies), la ligne la plus récente PARMI CELLES
    RENCONTRÉES. Le tri est nécessaire : l'ordre "par défaut" de l'API semble
    souvent regrouper les lignes par entité (ex. toutes celles d'une station
    d'affilée) plutôt que les mélanger — sans tri, un simple parcours des
    premières pages ne verrait donc jamais qu'une poignée d'entités, jamais
    les autres. Générique : ne suppose aucun nom de champ identifiant
    particulier.

    Les pages sont récupérées PLUSIEURS À LA FOIS (en parallèle, pas une par
    une) : jusqu'à 9900 lignes en pages de 100 peut nécessiter près de 100
    requêtes — enchaînées une par une, la seule latence réseau cumulée dépasse
    largement 90 secondes, tri ou pas."""
    import concurrent.futures

    def fetch_page(offset: int, sort: bool):
        """Récupère une page d'enregistrements avec les paramètres de tri nécessaires."""
        params = {"limit": page_size, "offset": offset}
        if sort:
            params["order_by"] = f"{temporal_field} DESC"
        response = requests.get(base_url, params=params, timeout=25)
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("results") or payload.get("records") or []
        return offset, response.url, payload.get("total_count"), (rows if isinstance(rows, list) else [])

    seen_locations: Dict[Tuple[float, float], Any] = {}
    seen_dates: Dict[Tuple[float, float], datetime] = {}
    total_api: Optional[int] = None
    first_url: Optional[str] = None
    pages_loaded = 0

    def ingest(rows) -> None:
        """Ajoute les enregistrements reçus au résultat en conservant la version la plus récente par emplacement."""
        for item in rows:
            record = _flatten_record(item)
            if not record:
                continue
            geometry = _geometry_from_record(record)
            if not geometry:
                continue
            # Clé d'entité générique : coordonnées arrondies pour un point (cas
            # le plus courant — stations, capteurs...), la géométrie complète
            # sérialisée pour tout le reste (lignes, polygones — ex. tronçons
            # de rue). Sans ce cas générique, tout dataset non ponctuel se
            # retrouvait silencieusement filtré à zéro résultat.
            if geometry.get("type") == "Point" and isinstance(geometry.get("coordinates"), list) and len(geometry["coordinates"]) == 2:
                key = (round(geometry["coordinates"][0], 4), round(geometry["coordinates"][1], 4))
            else:
                try:
                    key = json.dumps(geometry, sort_keys=True, default=str)
                except (TypeError, ValueError):
                    key = id(item)
            record_dt = _parse_temporal_datetime(record.get(temporal_field))
            current_dt = seen_dates.get(key)
            if key not in seen_locations or (record_dt is not None and (current_dt is None or record_dt > current_dt)):
                seen_locations[key] = item
                seen_dates[key] = record_dt

    # Première page seule : on en tire total_count pour savoir combien de
    # pages restent réellement à couvrir (jamais plus que max_records/total).
    # Certains champs temporels de type texte rejettent le tri (erreur de
    # comparaison de types côté API) : on retente alors sans tri plutôt que
    # d'abandonner tout le chargement.
    use_sort = True
    try:
        _, first_url, total_api, first_rows = fetch_page(0, sort=True)
    except requests.RequestException:
        use_sort = False
        _, first_url, total_api, first_rows = fetch_page(0, sort=False)
    pages_loaded += 1
    ingest(first_rows)
    if len(first_rows) < page_size or not total_api:
        truncated = False
        return list(seen_locations.values()), total_api, first_url, pages_loaded, truncated

    ceiling = min(max_records, int(total_api))
    remaining_offsets = list(range(page_size, ceiling, page_size))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(fetch_page, offset, use_sort): offset for offset in remaining_offsets}
        for future in concurrent.futures.as_completed(futures):
            try:
                _, _, _, rows = future.result()
            except requests.RequestException:
                continue
            if not rows:
                continue
            pages_loaded += 1
            ingest(rows)

    truncated = bool(total_api and ceiling < int(total_api))
    return list(seen_locations.values()), total_api, first_url, pages_loaded, truncated




__all__ = ['COUNT_FIELDS', 'DATASET_ID_PATTERN', 'DATA_GOUV_CACHE_DIR', 'DATA_GOUV_CONNECTOR', 'DATA_GOUV_PREFIX', 'GENERIC_API_MAX_RECORDS', 'LEGACY_ODS_DOMAINS', 'ODS_COMPOUND_ID_PATTERN', 'ODS_DOMAIN_PATTERN', 'ODS_ID_PREFIX', 'TOULOUSE_ODS_BASE', 'TOULOUSE_ODS_DOMAIN', '_as_geojson_geometry', '_build_ods_base', '_build_toulouse_records_url', '_classify_attribute_name', '_data_gouv_metadata_summary', '_date_prefix_format', '_detect_period_fields', '_detect_temporal_field', '_extract_ods_field_names', '_extract_ods_fields_with_labels', '_fetch_latest_per_location', '_fetch_paginated_records', '_fetch_records_active_in_period', '_fetch_temporal_day_records', '_field_profile', '_filter_records_same_date_nearest_time', '_flatten_record', '_geometry_from_record', '_is_known_dataset_id_shape', '_is_number', '_is_utc_temporal_field', '_live_dataset_schema', '_load_data_gouv_geojson', '_make_ods_dataset_id', '_metric_value_for_record', '_normalize_field_name', '_ods_date_literal', '_parse_date_hour', '_parse_json_if_needed', '_parse_ods_dataset_id', '_parse_temporal_datetime', '_period_range_for_dataset', '_point_from_value', '_records_to_geojson', '_scan_period_min_max', '_scan_temporal_min_max', '_selected_datetime_args', '_strip_accents', '_temporal_query_window', '_temporal_range_for_dataset', '_wkt_to_geojson_geometry']
