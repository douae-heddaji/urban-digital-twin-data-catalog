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


BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__, template_folder="templates")


from scripts.open_data_api import *  # noqa: F401,F403
from scripts.catalog import *  # noqa: F401,F403
from scripts.local_sources import *  # noqa: F401,F403
from scripts.join_engine import *  # noqa: F401,F403

HISTORY_DB_PATH = Path(__file__).resolve().parent / "history" / "history.db"
ZONE_SEARCH_CACHE: Dict[str, list[Dict[str, Any]]] = {}

# Noms de colonnes "code commune INSEE" observés selon les référentiels locaux
# (Contours IRIS utilise "code_insee", BD TOPO utilise "insee_commune"...).
# Ordre = priorité si plusieurs sont présentes.
@app.route("/")
@app.route("/index.html")
def index():
    """Assure le traitement associé à « index »."""
    return render_template("index.html")


@app.route("/wordcloud.html")
def wordcloud():
    """Assure le traitement associé à « wordcloud »."""
    return render_template("wordcloud.html")


@app.route("/wordcloud_visual.html")
def wordcloud_visual():
    """Assure le traitement associé à « wordcloud visual »."""
    return render_template("wordcloud_visual.html")




@app.route("/api/dataset-schema/<dataset_id>")
def api_dataset_schema(dataset_id: str):
    """Assure le traitement associé à « api dataset schema »."""
    if not _is_known_dataset_id_shape(dataset_id):
        return jsonify({"error": "Identifiant de dataset invalide"}), 400
    try:
        return jsonify(_live_dataset_schema(dataset_id))
    except Exception as exc:
        return jsonify({"error": "Impossible de récupérer le schéma réel du dataset", "details": str(exc)}), 502


@app.route("/api/dataset-temporal-range/<dataset_id>")
def api_dataset_temporal_range(dataset_id: str):
    """Assure le traitement associé à « api dataset temporal range »."""
    if not (_is_known_dataset_id_shape(dataset_id) or dataset_id.startswith(DATA_GOUV_PREFIX)):
        return jsonify({"error": "Identifiant de dataset invalide"}), 400
    try:
        return jsonify(_temporal_range_for_dataset(dataset_id))
    except Exception as exc:
        return jsonify({
            "error": "Impossible de déterminer la période temporelle réelle du dataset",
            "details": str(exc),
            "dataset": dataset_id,
        }), 502

@app.route("/api/dataset-period-range/<dataset_id>")
def api_dataset_period_range(dataset_id: str):
    """Assure le traitement associé à « api dataset period range »."""
    if not (_is_known_dataset_id_shape(dataset_id) or dataset_id.startswith(DATA_GOUV_PREFIX)):
        return jsonify({"error": "Identifiant de dataset invalide"}), 400
    try:
        return jsonify(_period_range_for_dataset(dataset_id))
    except Exception as exc:
        return jsonify({
            "error": "Impossible de déterminer la période de validité réelle du dataset",
            "details": str(exc),
            "dataset": dataset_id,
        }), 502

@app.route("/api/dataset-export-format/<dataset_id>")
def api_dataset_export_format(dataset_id: str):
    """Assure le traitement associé à « api dataset export format »."""
    if not (_is_known_dataset_id_shape(dataset_id) or dataset_id.startswith(DATA_GOUV_PREFIX)):
        return jsonify({"error": "Identifiant de dataset invalide"}), 400
    raw_format = _catalog_format_for_dataset(dataset_id)
    return jsonify({
        "dataset": dataset_id,
        "raw_format": raw_format,
        "export_format": _normalize_export_format(raw_format),
    })

def _export_geodataframe(frame, export_format: str, filename_base: str):
    """Convertit un GeoDataFrame dans le format demandé et retourne une réponse
    Flask prête à téléchargement. Retourne None si le format est inconnu.
    Partagé par /api/export et /api/export-cross-reference."""
    if export_format == "geojson":
        buffer = io.BytesIO(frame.to_crs("EPSG:4326").to_json(drop_id=True).encode("utf-8"))
        return send_file(buffer, mimetype="application/geo+json", as_attachment=True, download_name=f"{filename_base}.geojson")

    if export_format in EXPORT_DRIVERS:
        driver = EXPORT_DRIVERS[export_format]
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir) / f"{filename_base}.{export_format}"
            frame.to_file(tmp_path, driver=driver)
            if export_format == "shp":
                # Un shapefile est toujours plusieurs fichiers (.shp/.shx/.dbf/.prj...) : on les regroupe dans un zip pour un téléchargement unique.
                zip_buffer = io.BytesIO()
                with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                    for sibling in Path(tmp_dir).glob(f"{filename_base}.*"):
                        zf.write(sibling, arcname=sibling.name)
                zip_buffer.seek(0)
                return send_file(zip_buffer, mimetype="application/zip", as_attachment=True, download_name=f"{filename_base}_shp.zip")
            buffer = io.BytesIO(tmp_path.read_bytes())
        mimetypes_by_format = {"gpkg": "application/geopackage+sqlite3", "kml": "application/vnd.google-earth.kml+xml"}
        return send_file(buffer, mimetype=mimetypes_by_format.get(export_format, "application/octet-stream"), as_attachment=True, download_name=f"{filename_base}.{export_format}")

    if export_format in {"csv", "xlsx", "parquet"}:
        flat = frame.copy()
        flat["geometry_wkt"] = flat.geometry.to_wkt()
        flat = flat.drop(columns=["geometry"])
        buffer = io.BytesIO()
        if export_format == "csv":
            flat.to_csv(buffer, index=False, encoding="utf-8-sig")
            mimetype = "text/csv"
        elif export_format == "xlsx":
            flat.to_excel(buffer, index=False, engine="openpyxl")
            mimetype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            flat.to_parquet(buffer, index=False)
            mimetype = "application/octet-stream"
        buffer.seek(0)
        return send_file(buffer, mimetype=mimetype, as_attachment=True, download_name=f"{filename_base}.{export_format}")

    return None


def _build_cross_reference_gdf(base_gdf, base_prefix: str, other_gdf, other_prefix: str, pairs: list, base_is_a: bool):
    """Construit un tableau fusionné générique (valable pour n'importe quelle
    paire de datasets croisés, pas seulement un cas précis) : une ligne par
    correspondance base/autre trouvée (colonnes des deux jeux, préfixées par
    dataset pour éviter toute collision de noms), plus une ligne — colonnes de
    l'autre dataset laissées vides — pour chaque entité de base qui n'a aucune
    correspondance, afin de n'en perdre aucune silencieusement."""
    import geopandas as gpd

    base_cols = [c for c in base_gdf.columns if c not in ("geometry",) and not c.startswith("_source") and not c.startswith("_analysis")]
    other_cols = [c for c in other_gdf.columns if c not in ("geometry",) and not c.startswith("_source") and not c.startswith("_analysis")]

    matches: dict[int, list[int]] = {}
    for a_idx, b_idx in pairs:
        base_idx, other_idx = (a_idx, b_idx) if base_is_a else (b_idx, a_idx)
        matches.setdefault(base_idx, []).append(other_idx)

    base_by_index = base_gdf.set_index("_source_index", drop=False)
    other_by_index = other_gdf.set_index("_source_index", drop=False)

    rows = []
    geometries = []
    for idx, base_row in base_by_index.iterrows():
        base_values = {f"{base_prefix}_{col}": base_row[col] for col in base_cols}
        other_indices = matches.get(idx, [])
        if not other_indices:
            rows.append({**base_values, **{f"{other_prefix}_{col}": None for col in other_cols}})
            geometries.append(base_row.geometry)
            continue
        for other_idx in other_indices:
            other_row = other_by_index.loc[other_idx]
            rows.append({**base_values, **{f"{other_prefix}_{col}": other_row[col] for col in other_cols}})
            geometries.append(base_row.geometry)

    return gpd.GeoDataFrame(rows, geometry=geometries, crs=base_gdf.crs)


@app.route("/api/export", methods=["POST"])
def api_export():
    """Convert a GeoJSON payload (the data currently shown on the map for one
    dataset) into the requested export format and return it as a file.

    GPKG/Shapefile/KML require GeoPandas (and GDAL underneath) — listed in
    requirements.txt. CSV/XLSX/Parquet flatten the geometry into a WKT column
    since those formats have no native geometry type.
    """
    payload = request.get_json(silent=True) or {}
    geojson = payload.get("geojson")
    export_format = str(payload.get("format") or "geojson").strip().lower()
    filename_base = _slugify_for_filename(str(payload.get("filename") or "export"))
    if not isinstance(geojson, dict) or not geojson.get("features"):
        return jsonify({"error": "Aucune donnée à exporter."}), 400

    if export_format == "geojson":
        buffer = io.BytesIO(json.dumps(geojson, ensure_ascii=False).encode("utf-8"))
        return send_file(buffer, mimetype="application/geo+json", as_attachment=True, download_name=f"{filename_base}.geojson")

    try:
        import geopandas as gpd
    except ImportError:
        return jsonify({
            "error": "L’export dans ce format nécessite GeoPandas côté serveur.",
            "details": "Installez les dépendances listées dans requirements.txt (pip install -r requirements.txt), puis redémarrez le serveur.",
        }), 501

    try:
        frame = gpd.GeoDataFrame.from_features(geojson["features"], crs="EPSG:4326")
    except Exception as exc:
        return jsonify({"error": "Impossible d’interpréter les données à exporter.", "details": str(exc)}), 422

    try:
        response = _export_geodataframe(frame, export_format, filename_base)
        if response is None:
            return jsonify({"error": f"Format d’export non pris en charge : {export_format}."}), 400
        return response
    except ImportError as exc:
        return jsonify({
            "error": "Une dépendance nécessaire à ce format n’est pas installée.",
            "details": str(exc),
        }), 501
    except Exception as exc:
        return jsonify({"error": "La conversion vers ce format a échoué.", "details": str(exc)}), 502


@app.route("/api/export-cross-reference", methods=["POST"])
def api_export_cross_reference():
    """Exporte le résultat d'un croisement spatial entre deux datasets : une
    ligne par correspondance (colonnes des deux datasets, préfixées), plus les
    entités du dataset "base" sans correspondance (colonnes de l'autre vides).
    Générique : fonctionne pour n'importe quelle paire de datasets croisés,
    pas seulement une combinaison particulière."""
    payload = request.get_json(silent=True) or {}
    try:
        dataset_a = payload.get("dataset_a") or {}
        dataset_b = payload.get("dataset_b") or {}
        collection_a = payload.get("collection_a") or {}
        collection_b = payload.get("collection_b") or {}
        base = str(payload.get("base") or "a").strip().lower()
        export_format = str(payload.get("format") or "csv").strip().lower()
        if not dataset_a.get("id") or not dataset_b.get("id"):
            return jsonify({"error": "Deux datasets doivent être sélectionnés."}), 400
        if base not in ("a", "b"):
            return jsonify({"error": "Paramètre « base » invalide (attendu : a ou b)."}), 400

        analysis = _automatic_spatial_analysis(
            collection_a, collection_b,
            {"id": str(dataset_a["id"]), "title": str(dataset_a.get("title") or dataset_a["id"])},
            {"id": str(dataset_b["id"]), "title": str(dataset_b.get("title") or dataset_b["id"])},
            float(payload.get("distance_m") or 100),
        )
        pairs = analysis["_pairs"]
        gdf_a, gdf_b = analysis["_gdf_a"], analysis["_gdf_b"]

        prefix_a = _slugify_for_filename(str(dataset_a.get("title") or dataset_a["id"])).replace("-", "_")
        prefix_b = _slugify_for_filename(str(dataset_b.get("title") or dataset_b["id"])).replace("-", "_")

        if base == "a":
            merged = _build_cross_reference_gdf(gdf_a, prefix_a, gdf_b, prefix_b, pairs, base_is_a=True)
            filename_base = _slugify_for_filename(str(dataset_a.get("title") or dataset_a["id"]))
        else:
            merged = _build_cross_reference_gdf(gdf_b, prefix_b, gdf_a, prefix_a, pairs, base_is_a=False)
            filename_base = _slugify_for_filename(str(dataset_b.get("title") or dataset_b["id"]))

        if merged.empty:
            return jsonify({"error": "Aucune donnée à exporter pour ce croisement."}), 400

        response = _export_geodataframe(merged, export_format, filename_base)
        if response is None:
            return jsonify({"error": f"Format d’export non pris en charge : {export_format}."}), 400
        return response
    except (ValueError, TypeError) as exc:
        return jsonify({"error": "Export du croisement impossible", "details": str(exc)}), 422
    except Exception as exc:
        app.logger.exception("Erreur pendant l'export du croisement")
        return jsonify({"error": "Erreur interne pendant l'export du croisement", "details": str(exc)}), 500


def _history_connection() -> sqlite3.Connection:
    """Assure le traitement associé à « history connection »."""
    HISTORY_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(HISTORY_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@app.route("/api/dataset-history/<dataset_id>/dates")
def api_dataset_history_dates(dataset_id: str):
    """List every capture timestamp available for a dataset, for building a
    history picker. Captures are produced by history/capture.py, run
    independently of this Flask server (system scheduler / cron)."""
    if not HISTORY_DB_PATH.exists():
        return jsonify({"dataset": dataset_id, "captures": []})
    conn = _history_connection()
    try:
        rows = conn.execute(
            "SELECT captured_at FROM snapshots WHERE dataset_id = ? ORDER BY captured_at ASC",
            (dataset_id,),
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"dataset": dataset_id, "captures": [row["captured_at"] for row in rows]})


@app.route("/api/dataset-history/<dataset_id>")
def api_dataset_history_at(dataset_id: str):
    """Return the captured snapshot closest to the requested date/time (or
    the most recent one if no date is given). The capture timestamp
    (_captured_at) and, per-record, the _capture_date/_capture_heure fields
    were assigned by capture.py at capture time — not read from the source
    data, so this works even for datasets with no temporal field of their
    own."""
    if not HISTORY_DB_PATH.exists():
        return jsonify({"error": "Aucun historique n’a encore été capturé. Lance history/capture.py au moins une fois."}), 404

    date_str = (request.args.get("date") or "").strip()
    time_str = (request.args.get("time") or "00:00").strip()

    conn = _history_connection()
    try:
        rows = conn.execute(
            "SELECT captured_at, payload FROM snapshots WHERE dataset_id = ? ORDER BY captured_at ASC",
            (dataset_id,),
        ).fetchall()
        if not rows:
            return jsonify({"error": "Aucun instantané n’a encore été capturé pour ce dataset."}), 404

        if date_str:
            try:
                target = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
            except ValueError:
                return jsonify({"error": "Date ou heure invalide. Format attendu : AAAA-MM-JJ et HH:MM."}), 400
            best = min(rows, key=lambda row: abs(datetime.fromisoformat(row["captured_at"]) - target))
        else:
            best = rows[-1]
    finally:
        conn.close()

    result = json.loads(best["payload"])
    result["_captured_at"] = best["captured_at"]
    return jsonify(result)


@app.route("/api/history-scheduler/status")
def api_history_scheduler_status():
    """État du planificateur de capture automatique de l'historique :
    activé ou non, intervalle, dernière/prochaine exécution, dernier résumé."""
    return jsonify(history_scheduler.get_status())


@app.route("/api/history-scheduler/run-now", methods=["POST"])
def api_history_scheduler_run_now():
    """Déclenche une capture immédiate (pratique pour tester sans attendre
    l'intervalle). Bloque jusqu'à la fin de la capture — comportement voulu
    ici puisqu'il s'agit d'un déclenchement manuel explicite."""
    if not history_scheduler.ENABLED:
        return jsonify({"error": "La capture automatique est désactivée (HISTORY_SCHEDULER_ENABLED=0)."}), 409
    history_scheduler._run_capture_job()
    return jsonify(history_scheduler.get_status())


@app.route("/diagnostic-spatial")
def diagnostic_spatial_page():
    """Assure le traitement associé à « diagnostic spatial page »."""
    dataset_id = request.args.get("dataset", "")
    requested_title = request.args.get("title", "").strip()
    return render_template(
        "diagnostic_spatial.html",
        dataset_id=dataset_id,
        dataset_title=requested_title or dataset_id,
    )


@app.route("/api/spatial-diagnostic/<dataset_id>")
def api_spatial_diagnostic(dataset_id: str):
    """Assure le traitement associé à « api spatial diagnostic »."""
    dataset = _get_dataset_config(dataset_id)
    if not dataset:
        return jsonify({"error": "Identifiant de dataset invalide", "dataset": dataset_id}), 400

    title = request.args.get("title", "").strip() or dataset.get("title", dataset_id)

    if dataset.get("source_type") in {"local_geojson", "local_gpkg"}:
        loader = _local_geojson_to_response if dataset["source_type"] == "local_geojson" else _local_gpkg_to_response
        try:
            response = loader(dataset_id, dataset)
            features = response.get("features") or []
            return jsonify({
                "dataset": dataset_id,
                "title": title,
                "status": "direct_geo",
                "status_label": "Cartographiable directement",
                "confidence": "élevée",
                "records_sampled": len(features),
                "direct_geometry_records": len(features),
                "message": "Le fichier local contient déjà des géométries exploitables.",
            })
        except (FileNotFoundError, ValueError) as exc:
            return jsonify({"error": "Impossible d’analyser le fichier local", "details": str(exc)}), 502

    if dataset.get("source_type") == "local_csv":
        try:
            response = _local_csv_to_response(dataset_id, dataset)
            source_records = [feature.get("properties") or {} for feature in response.get("features", [])]
            join_candidates = _find_join_candidates(dataset_id, title, source_records)
            result = {
                "dataset": dataset_id,
                "title": title,
                "status": "join_required",
                "status_label": "Jointure requise (code IRIS)",
                "confidence": "n/a",
                "records_sampled": response["metadata"]["records_loaded"],
                "direct_geometry_records": 0,
                "message": response["metadata"]["message"],
                "join_candidates": join_candidates,
            }
            if join_candidates:
                best = join_candidates[0]
                result["confidence"] = best.get("confidence", "moyenne")
                if best.get("verified_by_values"):
                    result["message"] = (
                        "Aucune géométrie directe, mais un référentiel géographique "
                        "compatible a été trouvé après comparaison des valeurs (code IRIS)."
                    )
            return jsonify(result)
        except (FileNotFoundError, ValueError) as exc:
            return jsonify({"error": "Impossible d’analyser le fichier local", "details": str(exc)}), 502

    if dataset.get("source_type") == "data_gouv_auto":
        try:
            metadata, resources, best = _data_gouv_metadata_summary(dataset)
            if not best:
                return jsonify({
                    "dataset": dataset_id,
                    "title": title or metadata.get("title"),
                    "status": "not_spatial",
                    "status_label": "Non cartographiable automatiquement",
                    "confidence": "moyenne",
                    "resources": [],
                    "message": "Aucune ressource exploitable n’a été détectée sur la fiche data.gouv.fr. Le diagnostic de jointure reste nécessaire.",
                })
            try:
                geojson = _load_data_gouv_geojson(dataset_id, dataset)
                features = geojson.get("features") or []
                return jsonify({
                    "dataset": dataset_id,
                    "title": title or metadata.get("title"),
                    "status": "direct_geo",
                    "status_label": "Cartographiable directement",
                    "confidence": "élevée",
                    "records_sampled": min(len(features), 100),
                    "direct_geometry_records": len(features),
                    "selected_resource": geojson.get("metadata", {}),
                    "resource_candidates": [{
                        "title": item.get("title"),
                        "format": item.get("format"),
                        "kind": item.get("_connector_kind"),
                        "score": item.get("_connector_score"),
                    } for item in resources[:10]],
                    "message": "Une ressource géographique data.gouv.fr a été découverte, mise en cache et chargée automatiquement.",
                })
            except DataGouvConnectorError as exc:
                return jsonify({
                    "dataset": dataset_id,
                    "title": title or metadata.get("title"),
                    "status": "join_required",
                    "status_label": "Jointure ou géocodage à étudier",
                    "confidence": "faible",
                    "resource_candidates": [{
                        "title": item.get("title"),
                        "format": item.get("format"),
                        "kind": item.get("_connector_kind"),
                        "score": item.get("_connector_score"),
                    } for item in resources[:10]],
                    "message": str(exc),
                })
        except (requests.RequestException, ValueError, DataGouvConnectorError) as exc:
            return jsonify({"error": "Impossible d’analyser la fiche data.gouv.fr", "details": str(exc)}), 502

    try:
        # Un échantillon plus généreux que le minimum nécessaire pour l'affichage
        # des colonnes : certains datasets (ex. VélÔToulouse Disponibilité) ont
        # plusieurs lignes par entité réelle (une par type de véhicule), donc 100
        # lignes ne couvrent qu'une poignée d'entités distinctes — insuffisant
        # pour vérifier fiablement un recoupement de valeurs avec un référentiel.
        # Récupéré par pagination (l'API OpenDataSoft plafonne "limit" à 100 par
        # requête ; demander 500 d'un coup est rejeté avec une erreur 400).
        records, total_count, _, _, _ = _fetch_paginated_records(dataset["base_url"], max_records=500)
        diagnostic = _spatial_diagnostic_from_records(dataset_id, records, title)
        diagnostic["total_api"] = total_count

        flat_records = [record for item in records if (record := _flatten_record(item))]
        if diagnostic.get("status") != "direct_geo":
            join_candidates = _find_join_candidates(dataset_id, title, flat_records)
            diagnostic["join_candidates"] = join_candidates
            if join_candidates:
                best = join_candidates[0]
                # Une correspondance vérifiée par les valeurs transforme le diagnostic
                # en jointure potentielle, même si les colonnes ont des noms différents
                # ou si l'identifiant provient du titre du dataset.
                if best.get("verified_by_values"):
                    diagnostic["status"] = "join_required"
                    diagnostic["status_label"] = "Jointure géographique potentielle"
                    diagnostic["confidence"] = best.get("confidence", "moyenne")
                    diagnostic["message"] = (
                        "Aucune géométrie directe n’a été détectée, mais un référentiel "
                        "géographique compatible a été trouvé dans le catalogue après "
                        "comparaison des métadonnées et des valeurs."
                    )
                elif diagnostic.get("status") == "not_spatial":
                    diagnostic["status"] = "join_required"
                    diagnostic["status_label"] = "Référentiel géographique à vérifier"
                    diagnostic["confidence"] = "faible"
                    diagnostic["message"] = (
                        "Un ou plusieurs datasets géographiques du même domaine ont été "
                        "repérés, mais la correspondance des clés n’a pas encore pu être "
                        "confirmée par les valeurs de l’échantillon."
                    )
        return jsonify(diagnostic)
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        if status == 404:
            return jsonify({"error": "Dataset introuvable sur Open Data Toulouse Métropole", "dataset": dataset_id}), 404
        return jsonify({"error": "Impossible d’appeler l’API source", "details": str(exc)}), 502
    except requests.RequestException as exc:
        return jsonify({"error": "Impossible d’appeler l’API source", "details": str(exc)}), 502
    except ValueError as exc:
        return jsonify({"error": "Réponse API non JSON", "details": str(exc)}), 502
    except Exception as exc:
        # Filet de sécurité : sans ça, une erreur imprévue laisse Flask
        # renvoyer sa page HTML de debug, que le JS du front essaie ensuite
        # d'interpréter comme du JSON (d'où "Unexpected token '<'").
        return jsonify({"error": "Le diagnostic spatial a rencontré une erreur inattendue.", "details": str(exc)}), 500



@app.route("/api/join-reference/<source_dataset_id>/<target_dataset_id>")
def api_join_reference(source_dataset_id: str, target_dataset_id: str):
    """Create a cartographic join while preserving attributes from both datasets.

    The source dataset is the dataset that had no direct geometry. The target
    dataset is the selected geographic reference. Each returned feature uses the
    reference geometry and contains namespaced attributes from both sides of the
    join, so the popup represents the actual joined result rather than only the
    reference object.
    """
    source_dataset = _get_dataset_config(source_dataset_id)
    target_dataset = _get_dataset_config(target_dataset_id)
    if not source_dataset or not target_dataset:
        return jsonify({"error": "Dataset source ou référentiel invalide"}), 400

    source_title = request.args.get("source_title", "").strip() or source_dataset.get("title", source_dataset_id)
    source_field = request.args.get("source_field", "").strip()
    target_field = request.args.get("target_field", "").strip()
    if not source_field or not target_field:
        return jsonify({"error": "Les clés de jointure source et référentiel sont obligatoires."}), 400

    def public_properties_local(record: Dict[str, Any], prefix: str) -> Dict[str, Any]:
        """Assure le traitement associé à « public properties local »."""
        geometry_names = {"geo_shape", "geoshape", "geometry", "the_geom", "geom", "geo_point_2d", "geopoint", "geo_point"}
        properties: Dict[str, Any] = {}
        for key, value in record.items():
            normalized = _normalize_field_name(key)
            if key in geometry_names or normalized.startswith("geo_"):
                continue
            if value is None or value == "":
                continue
            properties[f"{prefix} — {key}"] = value
        return properties

    # Jointure entre deux fichiers locaux (ex. Recensement Population × Contours
    # IRIS) : pas d'API ODS impliquée, donc chemin dédié plus simple — pas de
    # dimension temporelle, pas de filtre serveur, tout est déjà en mémoire.
    if source_dataset.get("source_type") == "local_csv" and target_dataset.get("source_type") in {"local_gpkg", "local_geojson"}:
        try:
            source_response = _local_csv_to_response(source_dataset_id, source_dataset)
            source_records = [feature.get("properties") or {} for feature in source_response.get("features", [])]
            loader = _local_gpkg_to_response if target_dataset["source_type"] == "local_gpkg" else _local_geojson_to_response
            target_response = loader(target_dataset_id, target_dataset)
            target_records = [
                {**(feature.get("properties") or {}), "geometry": feature.get("geometry")}
                for feature in target_response.get("features", [])
            ]
        except (FileNotFoundError, ValueError) as exc:
            return jsonify({"error": "Impossible de charger les fichiers locaux pour la jointure", "details": str(exc)}), 502

        reference_index: Dict[str, list[Dict[str, Any]]] = {}
        for target_record in target_records:
            if not _geometry_from_record(target_record):
                continue
            for variant in _join_value_variants(target_record.get(target_field)):
                reference_index.setdefault(variant, []).append(target_record)

        features = []
        matched_reference_ids = set()
        matched_source_rows = 0
        for source_index, source_record in enumerate(source_records):
            variants = _join_value_variants(source_record.get(source_field))
            matches = []
            seen = set()
            for variant in variants:
                for target_record in reference_index.get(variant, []):
                    marker = id(target_record)
                    if marker not in seen:
                        seen.add(marker)
                        matches.append(target_record)
            if not matches:
                continue
            matched_source_rows += 1
            for target_record in matches:
                geometry = _geometry_from_record(target_record)
                if not geometry:
                    continue
                matched_reference_ids.add(id(target_record))
                properties = {
                    **public_properties_local(source_record, "Dataset analysé"),
                    **public_properties_local(target_record, "Référentiel géographique"),
                    "Jointure — clé du dataset": source_field,
                    "Jointure — clé du référentiel": target_field,
                    "Jointure — valeur(s) correspondante(s)": sorted(variants & _join_value_variants(target_record.get(target_field))),
                    "Jointure — référentiel utilisé": target_dataset.get("title", target_dataset_id),
                    "_joined_source_index": source_index,
                }
                features.append({"type": "Feature", "geometry": geometry, "properties": properties})

        geojson = {
            "type": "FeatureCollection",
            "features": features,
            "computed": {"metric": None, "metric_label": "Jointure attributaire et géographique", "metric_total": None, "metric_max": None},
            "metadata": {
                "dataset": source_dataset_id,
                "title": request.args.get("title", "").strip() or source_title,
                "source_dataset": source_dataset_id,
                "source_title": source_title,
                "reference_dataset": target_dataset_id,
                "reference_title": target_dataset.get("title", target_dataset_id),
                "source_field": source_field,
                "target_field": target_field,
                "source_records_loaded": len(source_records),
                "source_records_matched": matched_source_rows,
                "reference_records_matched": len(matched_reference_ids),
                "features_displayed": len(features),
                "total_reference_api": len(target_records),
                "records_loaded": len(target_records),
                "source_url": None,
                "pages_loaded": None,
                "truncated": False,
                "joined_dataset": True,
                "filtered_reference": True,
                "source_fields": sorted({key for record in source_records for key in record.keys()}),
                "reference_fields": sorted({key for record in target_records for key in record.keys()}),
                "temporal": {"temporal_available": False},
            },
        }
        if not features:
            return jsonify({
                "error": "Aucune entité géographique correspondante n’a été retrouvée dans le référentiel.",
                "details": f"Jointure testée : {source_field} → {target_field}.",
                "metadata": geojson["metadata"],
            }), 404
        return jsonify(geojson)

    if source_dataset.get("source_type") in {"local_geojson", "local_csv", "local_gpkg", "data_gouv_auto"}:
        return jsonify({"error": "Cette jointure filtrée n’est pas disponible pour cette source."}), 422
    if target_dataset.get("source_type") != "api_static_geo":
        return jsonify({"error": "Le référentiel ciblé n’est pas une API Open Data Toulouse compatible."}), 422

    def source_variants(record: Dict[str, Any], profile: Dict[str, Any]) -> set[str]:
        """Assure le traitement associé à « source variants »."""
        origin = profile.get("origin")
        if origin == "title_number":
            match = re.match(r"^\s*0*(\d{1,8})\b", source_title or "")
            if not match:
                return set()
            value = match.group(1)
            return {value, value.zfill(2)}
        if origin == "title_label":
            value = _normalize_join_value(source_title)
            return {value} if value else set()
        return _join_value_variants(record.get(source_field))

    def public_properties(record: Dict[str, Any], prefix: str) -> Dict[str, Any]:
        """Assure le traitement associé à « public properties »."""
        geometry_names = {"geo_shape", "geoshape", "geometry", "the_geom", "geom", "geo_point_2d", "geopoint", "geo_point"}
        properties: Dict[str, Any] = {}
        for key, value in record.items():
            normalized = _normalize_field_name(key)
            if key in geometry_names or normalized.startswith("geo_"):
                continue
            # Keep only real values returned by the source API. Empty catalogue
            # placeholders must never appear as dataset attributes.
            if value is None or value == "":
                continue
            properties[f"{prefix} — {key}"] = value
        return properties

    try:
        # First inspect a small real sample to detect the source schema and its
        # temporal field. When the user selected a date/time, only that calendar
        # day is queried. The chosen row is exact to the minute when possible,
        # otherwise the closest time from the SAME date is used.
        source_response = requests.get(
            source_dataset["base_url"], params={"limit": 100, "offset": 0}, timeout=25
        )
        source_response.raise_for_status()
        source_payload = source_response.json()
        source_sample_records = [
            record for item in (source_payload.get("results") or source_payload.get("records") or [])
            if (record := _flatten_record(item))
        ]
        temporal_field = _detect_temporal_field(source_dataset_id, source_sample_records)
        period_fields = _detect_period_fields(source_dataset_id, source_sample_records)
        date_str, time_str, selected_datetime, hour_specified = _selected_datetime_args()
        temporal_info: Dict[str, Any] = {
            "temporal_field": temporal_field,
            "temporal_available": bool(temporal_field),
        }
        if period_fields:
            temporal_info["period_available"] = True
            temporal_info["period_fields"] = {"start": period_fields[0], "end": period_fields[1]}

        if period_fields and selected_datetime:
            # Une seule date choisie : on veut les lignes dont la période
            # [date_debut, date_fin] INCLUT cette date précise (pas une plage
            # à fixer à part) — on réutilise la même fonction de recouvrement
            # en lui donnant une fenêtre d'un seul jour.
            range_start = selected_datetime.replace(hour=0, minute=0, second=0, microsecond=0)
            range_end = range_start.replace(hour=23, minute=59, second=59)
            start_field, end_field = period_fields
            source_records, selected_info = _fetch_records_active_in_period(
                source_dataset_id, source_dataset, start_field, end_field, range_start, range_end
            )
            temporal_info.update(selected_info)
            if not source_records:
                return jsonify({
                    "error": f"Aucune donnée n’est active le {date_str}.",
                    "metadata": temporal_info,
                }), 404
        elif selected_datetime and temporal_field:
            sample_value = next(
                (record.get(temporal_field) for record in source_sample_records if record.get(temporal_field)),
                None,
            )
            source_records, selected_info = _fetch_temporal_day_records(
                source_dataset_id, source_dataset, temporal_field, selected_datetime, sample_value, hour_specified
            )
            temporal_info.update(selected_info)
            if not source_records:
                return jsonify({
                    "error": f"Aucune donnée n’est disponible pour le {date_str}.",
                    "details": "La recherche de l’heure la plus proche est volontairement limitée à la date sélectionnée.",
                    "metadata": temporal_info,
                }), 404
        else:
            # Raccourci rapide pour le cas fréquent d'une entité SOURCE UNIQUE
            # dont la clé de jointure est le titre du dataset lui-même (donc
            # constante sur toutes les lignes — cas des stations météo
            # individuelles) : inutile de télécharger tout l'historique
            # (potentiellement des milliers de lignes sur plusieurs années)
            # juste pour en extraire la ligne la plus récente. On demande
            # directement à l'API triée par le champ temporel, en ne gardant
            # qu'une petite page — largement suffisant pour y retrouver la
            # vraie valeur la plus récente (revalidée en Python, l'ordre de
            # tri de l'API n'étant pas toujours garanti sur un champ texte).
            fast_path_used = False
            if source_field == "Libellé extrait du titre" and temporal_field:
                try:
                    fast_raw, _, _, _, _ = _fetch_paginated_records(
                        source_dataset["base_url"],
                        extra_params={"order_by": f"{temporal_field} DESC"},
                        max_records=100,
                    )
                    fast_records = [record for item in fast_raw if (record := _flatten_record(item))]
                    fast_parsed = [
                        (record, dt) for record in fast_records
                        if (dt := _parse_temporal_datetime(record.get(temporal_field))) is not None
                    ]
                    if fast_parsed:
                        source_records = [max(fast_parsed, key=lambda pair: pair[1])[0]]
                        fast_path_used = True
                except (requests.RequestException, ValueError):
                    pass  # on retombe sur le chemin complet ci-dessous
            if not fast_path_used:
                # Toujours récupérer l'ensemble du dataset et réduire à une ligne
                # par entité distincte (regroupée par la clé de jointure) : le
                # petit échantillon de 100 lignes ne couvre pas forcément toutes
                # les entités (ex. VélÔToulouse : ~466 stations mais plusieurs
                # lignes par station — une par type de véhicule). On ne dépend
                # plus d'un champ temporel pour déclencher cette réduction : un
                # champ comme "last_updated" peut n'être qu'un horodatage de
                # rafraîchissement global (identique sur toutes les lignes), pas
                # une vraie temporalité par entité, donc pas fiable pour décider
                # QUAND réduire. On réduit systématiquement dès qu'une clé de
                # jointure existe ; le champ temporel, s'il varie réellement par
                # ligne, sert seulement à départager les doublons d'une même
                # entité (sinon on garde simplement la première ligne rencontrée).
                all_source_raw, _, _, _, _ = _fetch_paginated_records(
                    source_dataset["base_url"], max_records=GENERIC_API_MAX_RECORDS
                )
                source_records = [record for item in all_source_raw if (record := _flatten_record(item))]
                if source_field:
                    grouped: dict[str, Dict[str, Any]] = {}
                    grouped_dt: dict[str, Optional[datetime]] = {}
                    isolated: list[Dict[str, Any]] = []
                    for record in source_records:
                        group_value = record.get(source_field)
                        group_key = _canonical_join_key(group_value) if group_value not in (None, "") else ""
                        if not group_key:
                            # Pas de clé exploitable sur cette ligne : la garder telle
                            # quelle plutôt que de la perdre silencieusement.
                            isolated.append(record)
                            continue
                        dt = _parse_temporal_datetime(record.get(temporal_field)) if temporal_field else None
                        if group_key not in grouped or (dt is not None and (grouped_dt.get(group_key) is None or dt > grouped_dt[group_key])):
                            grouped[group_key] = record
                            grouped_dt[group_key] = dt
                    source_records = list(grouped.values()) + isolated
                    temporal_info["match_type"] = "latest_per_entity" if temporal_field else "one_per_entity"
                    temporal_info["entities_matched"] = len(source_records)
        source_profiles = _candidate_source_fields(source_records, source_title)
        source_profile = next(
            (profile for profile in source_profiles.values() if profile.get("field") == source_field),
            None,
        )
        if not source_profile:
            return jsonify({
                "error": "La clé source détectée lors du diagnostic n’a pas pu être reconstruite.",
                "details": {
                    "source_field_demande": source_field,
                    "champs_trouves": sorted(source_profiles.keys()),
                    "nb_enregistrements_source": len(source_records),
                    "champs_presents_dans_le_premier_enregistrement": sorted(source_records[0].keys()) if source_records else [],
                },
            }), 422

        # Ne pas télécharger aveuglément jusqu'à 10 000 lignes du référentiel.
        # La jointure ne nécessite que les entités dont la clé correspond aux
        # valeurs de la source. On essaie d'abord un filtre OpenDataSoft côté API,
        # puis un parcours paginé borné avec arrêt dès qu'une correspondance existe.
        wanted_variants: set[str] = set()
        for source_record in source_records:
            wanted_variants.update(source_variants(source_record, source_profile))

        def ods_literal(value: str) -> str:
            """Assure le traitement associé à « ods literal »."""
            value = str(value).strip()
            if re.fullmatch(r"-?\d+(?:\.\d+)?", value):
                return value
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

        all_target = []
        total_api = None
        first_url = None
        pages_loaded = 0
        truncated = False
        _filter_phase_started = time.time()

        # Requête filtrée, découpée en petits groupes pour éviter une URL trop longue.
        # Important : pas de plafond arbitraire sur le nombre de variantes ici — un tel
        # plafond, combiné à un tri alphabétique, ne gardait par exemple que les
        # identifiants commençant par "1" et perdait silencieusement la majorité des
        # stations sur un référentiel de taille moyenne/grande (ex. VélÔToulouse, ~460
        # stations). On protège seulement contre un nombre déraisonnable de requêtes.
        variants_list = sorted(wanted_variants)
        chunk_size = 30
        max_chunk_requests = 80  # jusqu'à 2400 variantes couvertes, largement suffisant ici
        variants_capped = variants_list[: chunk_size * max_chunk_requests]
        for start in range(0, len(variants_capped), chunk_size):
            chunk = variants_capped[start:start + chunk_size]
            where = " OR ".join(f'`{target_field}` = {ods_literal(value)}' for value in chunk)
            try:
                response = requests.get(
                    target_dataset["base_url"],
                    params={"limit": 100, "offset": 0, "where": where},
                    timeout=12,
                )
                response.raise_for_status()
                payload = response.json()
                if first_url is None:
                    first_url = response.url
                if total_api is None:
                    total_api = payload.get("total_count")
                rows = payload.get("results") or payload.get("records") or []
                if isinstance(rows, list):
                    all_target.extend(rows)
                pages_loaded += 1
            except (requests.RequestException, ValueError):
                # Certaines colonnes ou anciennes versions d'ODS refusent le filtre.
                # Le repli paginé ci-dessous reste alors disponible.
                all_target = []
                break
        if len(variants_list) > len(variants_capped):
            truncated = True

        target_records = [record for item in all_target if (record := _flatten_record(item))]
        target_records = [
            record for record in target_records
            if _join_value_variants(record.get(target_field)) & wanted_variants
        ]
        print(
            f"[join-reference] phase filtrée : {time.time() - _filter_phase_started:.1f}s, "
            f"{pages_loaded} requête(s), {len(target_records)} correspondance(s)."
        )

        if not target_records:
            _fallback_started = time.time()
            page_size = 100
            offset = 0
            max_reference_records = 5000
            while offset < max_reference_records:
                response = requests.get(
                    target_dataset["base_url"],
                    params={"limit": page_size, "offset": offset},
                    timeout=12,
                )
                response.raise_for_status()
                payload = response.json()
                if first_url is None:
                    first_url = response.url
                if total_api is None:
                    total_api = payload.get("total_count")
                rows = payload.get("results") or payload.get("records") or []
                if not isinstance(rows, list) or not rows:
                    break
                pages_loaded += 1
                flattened = [record for item in rows if (record := _flatten_record(item))]
                matching = [
                    record for record in flattened
                    if _join_value_variants(record.get(target_field)) & wanted_variants
                ]
                target_records.extend(matching)
                # Important : on continue de parcourir toutes les pages jusqu'à
                # max_reference_records au lieu de s'arrêter à la première page
                # contenant ne serait-ce qu'une correspondance — sinon seules les
                # entités présentes tôt dans le référentiel étaient retrouvées.
                offset += len(rows)
                if len(rows) < page_size:
                    break
            truncated = truncated or bool(total_api and offset + page_size < int(total_api))
            print(
                f"[join-reference] repli scan complet : {time.time() - _fallback_started:.1f}s, "
                f"{offset} enregistrement(s) parcouru(s), {len(target_records)} correspondance(s)."
            )

        # Index the reference values once. This is substantially faster than
        # comparing every source row with every reference row.
        reference_index: Dict[str, list[Dict[str, Any]]] = {}
        for target_record in target_records:
            if not _geometry_from_record(target_record):
                continue
            for variant in _join_value_variants(target_record.get(target_field)):
                reference_index.setdefault(variant, []).append(target_record)

        features = []
        matched_reference_ids = set()
        matched_source_rows = 0
        for source_index, source_record in enumerate(source_records):
            variants = source_variants(source_record, source_profile)
            matches = []
            seen = set()
            for variant in variants:
                for target_record in reference_index.get(variant, []):
                    marker = id(target_record)
                    if marker not in seen:
                        seen.add(marker)
                        matches.append(target_record)
            if not matches:
                continue
            matched_source_rows += 1
            for target_record in matches:
                geometry = _geometry_from_record(target_record)
                if not geometry:
                    continue
                matched_reference_ids.add(id(target_record))
                properties = {
                    **public_properties(source_record, "Dataset analysé"),
                    **public_properties(target_record, "Référentiel géographique"),
                    "Jointure — clé du dataset": source_field,
                    "Jointure — clé du référentiel": target_field,
                    "Jointure — valeur(s) correspondante(s)": sorted(variants & _join_value_variants(target_record.get(target_field))),
                    "Jointure — référentiel utilisé": target_dataset.get("title", target_dataset_id),
                    "_joined_source_index": source_index,
                }
                features.append({"type": "Feature", "geometry": geometry, "properties": properties})

        geojson = {
            "type": "FeatureCollection",
            "features": features,
            "computed": {"metric": None, "metric_label": "Jointure attributaire et géographique", "metric_total": None, "metric_max": None},
            "metadata": {
                "dataset": source_dataset_id,
                "title": request.args.get("title", "").strip() or source_title,
                "source_dataset": source_dataset_id,
                "source_title": source_title,
                "reference_dataset": target_dataset_id,
                "reference_title": target_dataset.get("title", target_dataset_id),
                "source_field": source_field,
                "target_field": target_field,
                "source_records_loaded": len(source_records),
                "source_records_matched": matched_source_rows,
                "reference_records_matched": len(matched_reference_ids),
                "features_displayed": len(features),
                "total_reference_api": total_api if total_api is not None else len(target_records),
                "records_loaded": len(target_records),
                "source_url": first_url,
                "pages_loaded": pages_loaded,
                "truncated": truncated,
                "joined_dataset": True,
                "filtered_reference": True,
                "source_fields": sorted({key for record in source_records for key in record.keys()}),
                "reference_fields": sorted({key for record in target_records for key in record.keys()}),
                "temporal": temporal_info,
            },
        }
        if not features:
            return jsonify({
                "error": "Aucune entité géographique correspondante n’a été retrouvée dans le référentiel.",
                "details": f"Jointure testée : {source_field} → {target_field}.",
                "metadata": geojson["metadata"],
            }), 404
        return jsonify(geojson)
    except requests.RequestException as exc:
        return jsonify({"error": "Impossible d’appeler l’API source ou le référentiel", "details": str(exc)}), 502
    except ValueError as exc:
        return jsonify({"error": "Réponse API non JSON", "details": str(exc)}), 502


@app.route("/api/zone-search")
def search_named_zone():
    """Search a named place and return its administrative geometry when available.

    This proxy keeps the browser independent from third-party CORS settings and
    sends the identifying User-Agent required by the public Nominatim service.
    Results are cached in memory for the duration of the Flask process.
    """
    query = str(request.args.get("q", "")).strip()
    if len(query) < 2:
        return jsonify({"error": "Saisissez au moins deux caractères."}), 400

    cache_key = _strip_accents(query).lower()
    if cache_key in ZONE_SEARCH_CACHE:
        return jsonify({"results": ZONE_SEARCH_CACHE[cache_key], "cached": True})

    try:
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": query,
                "format": "jsonv2",
                "limit": 5,
                "countrycodes": "fr",
                "polygon_geojson": 1,
                "addressdetails": 1,
            },
            headers={
                "User-Agent": "urban-digital-twin-data-catalog/1.0 "
                              "(research prototype; contact via repository)",
                "Accept-Language": "fr",
            },
            timeout=20,
        )
        response.raise_for_status()
        raw_results = response.json()
    except requests.RequestException as exc:
        return jsonify({
            "error": "Le service de recherche géographique est temporairement indisponible.",
            "details": str(exc),
        }), 502

    results = []
    for item in raw_results if isinstance(raw_results, list) else []:
        bounding_box = item.get("boundingbox") or []
        if len(bounding_box) != 4:
            continue

        try:
            south, north, west, east = [float(value) for value in bounding_box]
        except (TypeError, ValueError):
            continue

        geometry = item.get("geojson")
        if not isinstance(geometry, dict) or not geometry.get("type"):
            geometry = None

        address = item.get("address") if isinstance(item.get("address"), dict) else {}
        results.append({
            "display_name": item.get("display_name") or query,
            "type": item.get("type") or item.get("addresstype") or "",
            "category": item.get("category") or item.get("class") or "",
            "lat": item.get("lat"),
            "lon": item.get("lon"),
            "bbox": {
                "south": south,
                "north": north,
                "west": west,
                "east": east,
            },
            "geometry": geometry,
            "address": {
                "city": address.get("city") or address.get("town") or address.get("village") or address.get("municipality"),
                "postcode": address.get("postcode"),
                "department": address.get("county"),
                "region": address.get("state"),
            },
        })

    ZONE_SEARCH_CACHE[cache_key] = results
    return jsonify({"results": results, "cached": False})


@app.route("/carte")
def carte():
    """Assure le traitement associé à « carte »."""
    dataset_id = request.args.get("dataset", "comptages-routiers-et-pietons-2025")
    dataset = _get_dataset_config(dataset_id)
    requested_title = request.args.get("title", "").strip()
    return render_template(
        "carte.html",
        dataset_id=dataset_id,
        dataset_title=requested_title or (dataset or {}).get("title", dataset_id),
    )


@app.route("/api/dataset/<dataset_id>")
def api_dataset(dataset_id: str):
    """Assure le traitement associé à « api dataset »."""
    dataset = _get_dataset_config(dataset_id)
    if not dataset:
        return jsonify({"error": "Identifiant de dataset invalide", "dataset": dataset_id}), 400

    if dataset.get("source_type") in {"local_geojson", "local_gpkg"}:
        loader = _local_geojson_to_response if dataset["source_type"] == "local_geojson" else _local_gpkg_to_response
        try:
            result = loader(dataset_id, dataset)
        except FileNotFoundError:
            return jsonify({"error": "Fichier local introuvable", "dataset": dataset_id}), 404
        except ValueError as exc:
            return jsonify({"error": "Fichier local invalide", "details": str(exc)}), 502

        # Filtre optionnel par catégorie (ex. BD TOPO "batiment" : la colonne
        # réelle peut s'appeler "usage1" ou "usage_1" selon le fichier) —
        # appliqué après coup sur les données déjà chargées/cachées, pas besoin
        # d'un cache séparé par combinaison de filtres. On n'accepte que des
        # noms de paramètres correspondant à une colonne de catégorie réellement
        # détectée (available_categories), pas n'importe quel nom de colonne.
        available_categories = result.get("metadata", {}).get("available_categories", {})
        category_filters = {
            key: request.args.get(key)
            for key in available_categories
            if request.args.get(key)
        }
        if category_filters:
            filtered_features = [
                feature for feature in result.get("features", [])
                if all((feature.get("properties") or {}).get(key) == value for key, value in category_filters.items())
            ]
            result = {**result, "features": filtered_features}
            result["metadata"] = {**result["metadata"], "features_displayed": len(filtered_features), "active_category_filters": category_filters}

        return jsonify(result)

    if dataset.get("source_type") == "local_csv":
        try:
            return jsonify(_local_csv_to_response(dataset_id, dataset))
        except FileNotFoundError:
            return jsonify({"error": "Fichier CSV introuvable — avez-vous lancé scripts/filter_recensement_population.py ?", "dataset": dataset_id}), 404
        except ValueError as exc:
            return jsonify({"error": "Fichier CSV invalide", "details": str(exc)}), 502

    if dataset.get("source_type") == "data_gouv_auto":
        try:
            return jsonify(_load_data_gouv_geojson(dataset_id, dataset))
        except DataGouvConnectorError as exc:
            return jsonify({
                "error": "Aucune ressource cartographique data.gouv.fr n’a pu être chargée",
                "details": str(exc),
                "dataset": dataset_id,
            }), 422
        except requests.RequestException as exc:
            return jsonify({"error": "Impossible d’appeler data.gouv.fr", "details": str(exc)}), 502
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            return jsonify({"error": "Ressource data.gouv.fr invalide", "details": str(exc)}), 502

    if dataset.get("source_type") == "api_static_geo":
        try:
            date_str, time_str, selected_datetime, hour_specified = _selected_datetime_args()

            # Detect the temporal field from a small sample first. When a
            # date/time is selected there is no need to also download up to
            # 10 000 records here: _fetch_temporal_day_records below already
            # fetches exactly what is needed (and does so with a bounded,
            # early-exiting scan), so doing both was pure wasted time that
            # could push a valid, existing date past the client's 60s limit.
            sample_response = requests.get(
                dataset["base_url"], params={"limit": 100, "offset": 0}, timeout=25
            )
            sample_response.raise_for_status()
            sample_payload = sample_response.json()
            sample_raw = sample_payload.get("results") or sample_payload.get("records") or []
            flat_sample = [record for item in sample_raw if (record := _flatten_record(item))]
            temporal_field = _detect_temporal_field(dataset_id, flat_sample)
            period_fields = _detect_period_fields(dataset_id, flat_sample)

            temporal_info: Dict[str, Any] = {"temporal_available": False, "temporal_field": None}
            if temporal_field:
                temporal_info.update({"temporal_available": True, "temporal_field": temporal_field})
            if period_fields:
                temporal_info["period_available"] = True
                temporal_info["period_fields"] = {"start": period_fields[0], "end": period_fields[1]}

            is_generic = dataset_id not in DATASET_OVERRIDES
            max_records = GENERIC_API_MAX_RECORDS if is_generic else None

            if period_fields and selected_datetime:
                # Une seule date choisie : on veut les lignes dont la période
                # [date_debut, date_fin] INCLUT cette date précise (pas une
                # plage à fixer séparément) — même fonction de recouvrement,
                # avec une fenêtre d'un seul jour.
                range_start = selected_datetime.replace(hour=0, minute=0, second=0, microsecond=0)
                range_end = range_start.replace(hour=23, minute=59, second=59)
                start_field, end_field = period_fields
                selected_records, selected_info = _fetch_records_active_in_period(
                    dataset_id, dataset, start_field, end_field, range_start, range_end
                )
                temporal_info.update(selected_info)
                if not selected_records:
                    return jsonify({
                        "error": f"Aucune donnée n’est active le {date_str}.",
                        "metadata": temporal_info,
                    }), 404
                all_results = selected_records
                total_api = len(selected_records)
                first_url = None
                pages_loaded = None
                truncated = False
            elif selected_datetime and temporal_field:
                sample_value = next(
                    (record.get(temporal_field) for record in flat_sample if record.get(temporal_field)),
                    None,
                )
                selected_records, selected_info = _fetch_temporal_day_records(
                    dataset_id, dataset, temporal_field, selected_datetime, sample_value, hour_specified
                )
                temporal_info.update(selected_info)
                if not selected_records:
                    return jsonify({
                        "error": f"Aucune donnée n’est disponible pour le {date_str}.",
                        "details": "Aucune ligne d’une autre date n’a été utilisée.",
                        "metadata": temporal_info,
                    }), 404
                all_results = selected_records
                total_api = len(selected_records)
                first_url = selected_info.get("source_url")
                pages_loaded = selected_info.get("pages_loaded")
                truncated = bool(selected_info.get("truncated"))
            else:
                # Sans date choisie : on veut TOUS les points distincts du
                # dataset (pas seulement les stations qui relèvent le plus
                # souvent), sans pour autant tout télécharger bêtement jusqu'à
                # 9900 lignes à chaque fois. _fetch_latest_per_location trie
                # par date décroissante et s'arrête dès que plus aucun
                # nouveau point géographique n'apparaît (au lieu d'un plafond
                # de lignes fixe) — rapide sur un dataset à peu d'entités
                # distinctes, complet même si certaines relèvent rarement
                # (ex. une station météo isolée), et ne dépasse jamais le
                # plafond de sécurité de l'API en dernier recours.
                try:
                    if temporal_field:
                        all_results, total_api, first_url, pages_loaded, truncated = _fetch_latest_per_location(
                            dataset["base_url"], temporal_field, max_records or GENERIC_API_MAX_RECORDS
                        )
                    else:
                        all_results, total_api, first_url, pages_loaded, truncated = _fetch_paginated_records(
                            dataset["base_url"],
                            max_records=max_records,
                        )
                except requests.RequestException:
                    if not temporal_field:
                        raise
                    # Certains champs texte non triables côté API rejettent
                    # order_by : on retombe sur la récupération non triée.
                    all_results, total_api, first_url, pages_loaded, truncated = _fetch_paginated_records(
                        dataset["base_url"],
                        max_records=max_records,
                    )

            combined_payload = {
                "results": all_results,
                "total_count": total_api if total_api is not None else len(all_results),
            }
            geojson = _records_to_geojson(combined_payload, None)
            geometry_types = sorted({
                feature.get("geometry", {}).get("type", "Non renseigné")
                for feature in geojson["features"]
                if isinstance(feature, dict)
            })
            geojson["metadata"] = {
                "dataset": dataset_id,
                "title": request.args.get("title", "").strip() or dataset["title"],
                "source_type": "api_static_geo_auto" if is_generic else "api_static_geo",
                "source_url": first_url,
                "page_size": 100,
                "pages_loaded": pages_loaded,
                "records_loaded": len(all_results),
                "total_api": total_api if total_api is not None else len(all_results),
                "features_displayed": len(geojson["features"]),
                "geometry_types": geometry_types,
                "truncated": truncated,
                "max_records": max_records,
                "temporal": temporal_info,
            }

            if (total_api or all_results) and not geojson["features"]:
                return jsonify({
                    "error": "Ce dataset ne contient aucune géométrie directement exploitable.",
                    "details": "Aucun GeoPoint, GeoShape, GeoJSON ou couple latitude/longitude n’a été détecté dans les enregistrements.",
                    "metadata": geojson["metadata"],
                }), 422

            return jsonify(geojson)
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else 502
            if status == 404:
                return jsonify({
                    "error": "Dataset introuvable sur Open Data Toulouse Métropole",
                    "dataset": dataset_id,
                }), 404
            return jsonify({"error": "Impossible d’appeler l’API source", "details": str(exc)}), 502
        except requests.RequestException as exc:
            return jsonify({"error": "Impossible d’appeler l’API source", "details": str(exc)}), 502
        except ValueError as exc:
            return jsonify({"error": "Réponse API non JSON", "details": str(exc)}), 502

    metric = request.args.get("metric", "pedestrian_count")
    if metric not in COUNT_FIELDS:
        metric = "pedestrian_count"

    date_field = dataset.get("date_field", "started_at")
    requested_date = request.args.get("date")
    if not requested_date:
        # Sans date fournie : la plus récente réellement disponible, pas une
        # valeur figée dans le code (qui deviendrait fausse — ou pire, vide —
        # dès que le dataset ne couvre plus cette date précise). Une requête
        # triée + limit=1 est rapide même sur un dataset volumineux (plus de
        # 500 000 lignes ici) ; contrairement à _scan_temporal_min_max, qui
        # parcourt page par page et devient beaucoup trop lente à cette
        # échelle — on ne s'en sert qu'en dernier recours, si le tri est
        # rejeté par l'API (champ non trié de type texte, par exemple).
        max_dt = None
        try:
            edge_response = requests.get(
                dataset["base_url"],
                params={"limit": 1, "offset": 0, "order_by": f"{date_field} DESC", "where": f"{date_field} is not null"},
                timeout=15,
            )
            edge_response.raise_for_status()
            edge_rows = edge_response.json().get("results") or edge_response.json().get("records") or []
            for item in edge_rows:
                record = _flatten_record(item)
                parsed = _parse_temporal_datetime(record.get(date_field))
                if parsed:
                    max_dt = parsed
                    break
        except requests.RequestException:
            pass
        if max_dt is None:
            _, max_dt = _scan_temporal_min_max(dataset, date_field)
        if max_dt is not None:
            requested_date = max_dt.date().isoformat()
    date_str, hour, start, end = _parse_date_hour(requested_date, request.args.get("hour"))
    where = (
        f'{date_field} >= "{start.isoformat()}" '
        f'AND {date_field} < "{end.isoformat()}"'
    )

    try:
        all_results, total_api, first_url, pages_loaded, _ = _fetch_paginated_records(
            dataset["base_url"],
            extra_params={"where": where, "order_by": f"{date_field} ASC"},
        )

        combined_payload = {
            "results": all_results,
            "total_count": total_api if total_api is not None else len(all_results),
        }
        geojson = _records_to_geojson(combined_payload, metric)
        geojson["metadata"] = {
            "dataset": dataset_id,
            "title": request.args.get("title", "").strip() or dataset["title"],
            "source_url": first_url,
            "where": where,
            "date": date_str,
            "hour": hour,
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "page_size": 100,
            "pages_loaded": pages_loaded,
            "records_loaded": len(all_results),
            "total_api": total_api if total_api is not None else len(all_results),
            "features_displayed": len(geojson["features"]),
        }
        return jsonify(geojson)
    except requests.RequestException as exc:
        return jsonify({"error": "Impossible d’appeler l’API source", "details": str(exc)}), 502
    except ValueError as exc:
        return jsonify({"error": "Réponse API non JSON", "details": str(exc)}), 502


@app.route("/api/spatial-analysis-multi", methods=["POST"])
def api_spatial_analysis_multi():
    """Assure le traitement associé à « api spatial analysis multi »."""
    payload = request.get_json(silent=True) or {}
    try:
        items = payload.get("datasets") or []
        if not isinstance(items, list):
            return jsonify({"error": "La liste des datasets est invalide."}), 400
        result = _multi_spatial_analysis(items, float(payload.get("distance_m") or 100))
        return jsonify(result)
    except (ValueError, TypeError) as exc:
        return jsonify({"error": "Analyse spatiale multiple impossible", "details": str(exc)}), 422
    except Exception as exc:
        app.logger.exception("Erreur pendant l'analyse spatiale multiple")
        return jsonify({"error": "Erreur interne pendant l'analyse multiple", "details": str(exc)}), 500


@app.route("/api/spatial-analysis", methods=["POST"])
def api_spatial_analysis():
    """Assure le traitement associé à « api spatial analysis »."""
    payload = request.get_json(silent=True) or {}
    try:
        dataset_a = payload.get("dataset_a") or {}
        dataset_b = payload.get("dataset_b") or {}
        collection_a = payload.get("collection_a") or {}
        collection_b = payload.get("collection_b") or {}
        if not dataset_a.get("id") or not dataset_b.get("id"):
            return jsonify({"error": "Deux datasets doivent être sélectionnés."}), 400
        if dataset_a.get("id") == dataset_b.get("id"):
            return jsonify({"error": "Sélectionne deux datasets différents."}), 400
        result = _automatic_spatial_analysis(
            collection_a, collection_b,
            {"id": str(dataset_a["id"]), "title": str(dataset_a.get("title") or dataset_a["id"])},
            {"id": str(dataset_b["id"]), "title": str(dataset_b.get("title") or dataset_b["id"])},
            float(payload.get("distance_m") or 100),
        )
        # "_pairs"/"_gdf_a"/"_gdf_b" sont un usage interne (export fusionné) :
        # jamais envoyés au frontend, et non sérialisables tels quels (GeoDataFrame).
        result = {key: value for key, value in result.items() if not key.startswith("_")}
        return jsonify(result)
    except (ValueError, TypeError) as exc:
        return jsonify({"error": "Analyse spatiale impossible", "details": str(exc)}), 422
    except Exception as exc:
        app.logger.exception("Erreur pendant l’analyse spatiale")
        return jsonify({"error": "Erreur interne pendant l’analyse spatiale", "details": str(exc)}), 500


@app.route("/data/<path:filename>")
def data_file(filename: str):
    """Expose uniquement les fichiers de données locaux nécessaires à l'application."""
    return send_from_directory(BASE_DIR / "data", filename)


if __name__ == "__main__":
    import os as _os

    # Fixée AVANT le test ci-dessous (et réutilisée dans l'appel app.run() plus
    # bas) : app.debug n'est lui-même activé QUE par app.run(debug=True), donc
    # le tester avant cet appel renvoie toujours False, peu importe ce qu'on
    # lui passera ensuite — ça faisait démarrer le planificateur deux fois.
    DEBUG_MODE = True

    # En mode debug, Flask/Werkzeug relance le script dans un sous-processus
    # (le rechargeur automatique) : sans cette vérification, le planificateur
    # démarrerait deux fois (une fois par processus). WERKZEUG_RUN_MAIN n'est
    # défini que dans le vrai processus qui sert les requêtes.
    if not DEBUG_MODE or _os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        history_scheduler.start()
    # threaded=True : nécessaire pour que les appels HTTP internes du
    # planificateur (vers l'API de cette même application) ne restent pas
    # bloqués derrière la requête d'un utilisateur, et inversement.
    app.run(debug=DEBUG_MODE, threaded=True)
