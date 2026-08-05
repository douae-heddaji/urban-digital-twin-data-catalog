from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional
from urllib.parse import urlparse

import requests


class DataGouvConnectorError(RuntimeError):
    """Erreur contrôlée du connecteur data.gouv.fr."""


class DataGouvConnector:
    """Découvre et charge automatiquement la meilleure ressource data.gouv.fr.

    Priorité : GeoJSON > GPKG > SHP/ZIP > CSV > JSON.
    Les fichiers sont conservés dans un cache local avec un fichier manifeste.
    """

    API_BASE = "https://www.data.gouv.fr/api/1/datasets"
    PRIORITY = {
        "geojson": 0,
        "gpkg": 10,
        "geopackage": 10,
        "shp": 20,
        "shapefile": 20,
        "zip": 25,
        "csv": 30,
        "json": 40,
    }
    MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024

    def __init__(self, cache_dir: Path, timeout: int = 45) -> None:
        """Assure le traitement associé à « init »."""
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout

    @staticmethod
    def extract_dataset_identifier(value: str) -> Optional[str]:
        """Extrait dataset identifier."""
        text = str(value or "").strip()
        if text.startswith("datagouv--"):
            identifier = text[len("datagouv--"):]
            return identifier if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}", identifier) else None
        match = re.search(r"data\.gouv\.fr/(?:fr/)?datasets/([^/?#]+)", text, re.I)
        if not match:
            return None
        identifier = match.group(1).strip()
        return identifier if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}", identifier) else None

    def fetch_metadata(self, identifier: str) -> Dict[str, Any]:
        """Récupère metadata."""
        response = requests.get(f"{self.API_BASE}/{identifier}/", timeout=self.timeout)
        if response.status_code == 404:
            raise DataGouvConnectorError("Jeu de données introuvable sur data.gouv.fr.")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise DataGouvConnectorError("Réponse de métadonnées data.gouv.fr invalide.")
        return payload

    @staticmethod
    def _resource_text(resource: Dict[str, Any]) -> str:
        """Assure le traitement associé à « resource text »."""
        return " ".join(str(resource.get(key) or "") for key in ("format", "title", "description", "url"))

    @classmethod
    def resource_kind(cls, resource: Dict[str, Any]) -> str:
        """Assure le traitement associé à « resource kind »."""
        text = cls._resource_text(resource).lower()
        url_path = urlparse(str(resource.get("url") or "")).path.lower()
        suffix = Path(url_path).suffix.lower().lstrip(".")
        fmt = str(resource.get("format") or "").strip().lower().replace(".", "")

        if "geojson" in text or suffix == "geojson":
            return "geojson"
        if fmt in {"gpkg", "geopackage"} or suffix == "gpkg":
            return "gpkg"
        if fmt in {"shp", "shapefile"} or suffix == "shp":
            return "shp"
        if suffix == "zip" or fmt == "zip":
            return "zip"
        if fmt == "csv" or suffix == "csv":
            return "csv"
        if fmt == "json" or suffix == "json":
            return "json"
        return ""

    @classmethod
    def rank_resources(cls, resources: Iterable[Dict[str, Any]]) -> list[Dict[str, Any]]:
        """Assure le traitement associé à « rank resources »."""
        ranked = []
        for resource in resources:
            if not isinstance(resource, dict) or not resource.get("url"):
                continue
            kind = cls.resource_kind(resource)
            if not kind:
                continue
            score = cls.PRIORITY[kind]
            text = cls._resource_text(resource).lower()
            # Bonus aux ressources explicitement spatiales et pénalité aux docs/exemples.
            if re.search(r"geo|spatial|coordonn|latitude|longitude|shape", text):
                score -= 3
            if re.search(r"documentation|schema|dictionnaire|exemple|metadata|metadonne", text):
                score += 20
            ranked.append({**resource, "_connector_kind": kind, "_connector_score": score})
        ranked.sort(key=lambda item: (item["_connector_score"], str(item.get("title") or "")))
        return ranked

    @classmethod
    def choose_best_resource(cls, resources: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Assure le traitement associé à « choose best resource »."""
        ranked = cls.rank_resources(resources)
        return ranked[0] if ranked else None

    @staticmethod
    def _resource_version(resource: Dict[str, Any]) -> str:
        """Assure le traitement associé à « resource version »."""
        checksum = resource.get("checksum")
        if isinstance(checksum, dict):
            checksum = f"{checksum.get('type', '')}:{checksum.get('value', '')}"
        raw = "|".join(str(resource.get(key) or "") for key in (
            "id", "url", "last_modified", "last_modified_internal", "modified", "filesize", "mime"
        )) + f"|{checksum or ''}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def _safe(value: Any) -> str:
        """Assure le traitement associé à « safe »."""
        clean = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "")).strip("._")
        return clean[:120] or "resource"

    def _cache_paths(self, dataset_identifier: str, resource: Dict[str, Any]) -> tuple[Path, Path]:
        """Assure le traitement associé à « cache paths »."""
        dataset_dir = self.cache_dir / self._safe(dataset_identifier)
        dataset_dir.mkdir(parents=True, exist_ok=True)
        kind = resource.get("_connector_kind") or self.resource_kind(resource) or "bin"
        url_suffix = Path(urlparse(str(resource.get("url") or "")).path).suffix
        suffix = url_suffix if url_suffix else f".{kind}"
        resource_name = self._safe(resource.get("id") or resource.get("title") or "resource")
        return dataset_dir / f"{resource_name}{suffix}", dataset_dir / f"{resource_name}.manifest.json"

    def download_resource(self, dataset_identifier: str, resource: Dict[str, Any]) -> tuple[Path, bool]:
        """Télécharge resource."""
        target, manifest_path = self._cache_paths(dataset_identifier, resource)
        version = self._resource_version(resource)
        if target.exists() and manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if manifest.get("version") == version:
                    return target, True
            except (OSError, ValueError):
                pass

        url = str(resource.get("url") or "").strip()
        if not url:
            raise DataGouvConnectorError("La ressource sélectionnée ne possède pas d’URL.")

        tmp = target.with_suffix(target.suffix + ".part")
        total = 0
        try:
            with requests.get(url, stream=True, timeout=self.timeout, allow_redirects=True) as response:
                response.raise_for_status()
                content_length = int(response.headers.get("content-length") or 0)
                if content_length and content_length > self.MAX_DOWNLOAD_BYTES:
                    raise DataGouvConnectorError("La ressource dépasse la taille maximale autorisée (250 Mo).")
                with tmp.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > self.MAX_DOWNLOAD_BYTES:
                            raise DataGouvConnectorError("La ressource dépasse la taille maximale autorisée (250 Mo).")
                        handle.write(chunk)
            tmp.replace(target)
            manifest_path.write_text(json.dumps({
                "version": version,
                "resource_id": resource.get("id"),
                "url": url,
                "kind": resource.get("_connector_kind") or self.resource_kind(resource),
                "bytes": total,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            return target, False
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)

    @staticmethod
    def _feature_collection(value: Any) -> Optional[Dict[str, Any]]:
        """Assure le traitement associé à « feature collection »."""
        if isinstance(value, dict) and value.get("type") == "FeatureCollection" and isinstance(value.get("features"), list):
            return value
        if isinstance(value, dict) and value.get("type") == "Feature" and isinstance(value.get("geometry"), dict):
            return {"type": "FeatureCollection", "features": [value]}
        return None

    @staticmethod
    def _read_json(path: Path) -> Any:
        """Assure le traitement associé à « read json »."""
        with path.open("r", encoding="utf-8-sig") as handle:
            return json.load(handle)

    @staticmethod
    def _read_csv_records(path: Path, max_records: int = 50_000) -> list[Dict[str, Any]]:
        """Assure le traitement associé à « read csv records »."""
        raw = path.read_bytes()
        text = raw.decode("utf-8-sig", errors="replace")
        sample = text[:8192]
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        return [dict(row) for _, row in zip(range(max_records), reader)]

    @staticmethod
    def _load_with_geopandas(path: Path) -> Dict[str, Any]:
        """Charge with geopandas."""
        try:
            import geopandas as gpd  # type: ignore
        except ImportError as exc:
            raise DataGouvConnectorError(
                "Cette ressource nécessite GeoPandas (GeoPackage ou Shapefile). "
                "Installez l’option géographique indiquée dans requirements.txt."
            ) from exc
        frame = gpd.read_file(path)
        if frame.crs is not None and str(frame.crs).upper() != "EPSG:4326":
            frame = frame.to_crs(epsg=4326)
        return json.loads(frame.to_json())

    def load_first_spatial_resource(
        self,
        dataset_identifier: str,
        resources: Iterable[Dict[str, Any]],
        *,
        records_to_geojson: Callable[[Dict[str, Any], Optional[str]], Dict[str, Any]],
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        """Try ranked resources until one yields non-empty geometries."""
        attempts = []
        for resource in self.rank_resources(resources):
            try:
                geojson, meta = self.load_resource(
                    dataset_identifier,
                    resource,
                    records_to_geojson=records_to_geojson,
                )
                meta["attempted_resources"] = attempts + [{
                    "title": resource.get("title"),
                    "format": resource.get("format"),
                    "kind": resource.get("_connector_kind"),
                    "status": "success",
                }]
                return geojson, meta
            except Exception as exc:
                attempts.append({
                    "title": resource.get("title"),
                    "format": resource.get("format"),
                    "kind": resource.get("_connector_kind"),
                    "status": "failed",
                    "error": str(exc),
                })

        details = "; ".join(
            f"{item.get('title') or item.get('kind')}: {item.get('error')}"
            for item in attempts[:5]
        )
        raise DataGouvConnectorError(
            "Aucune ressource cartographique data.gouv.fr n’a pu être chargée"
            + (f". Essais : {details}" if details else ".")
        )

    def load_resource(
        self,
        dataset_identifier: str,
        resource: Dict[str, Any],
        *,
        records_to_geojson: Callable[[Dict[str, Any], Optional[str]], Dict[str, Any]],
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        """Charge resource."""
        path, cache_hit = self.download_resource(dataset_identifier, resource)
        kind = resource.get("_connector_kind") or self.resource_kind(resource)

        if kind in {"geojson", "json"}:
            payload = self._read_json(path)
            direct = self._feature_collection(payload)
            if direct:
                geojson = direct
            elif isinstance(payload, list):
                geojson = records_to_geojson({"results": payload}, None)
            elif isinstance(payload, dict):
                records = payload.get("results") or payload.get("records") or payload.get("data")
                if isinstance(records, list):
                    geojson = records_to_geojson({"results": records}, None)
                else:
                    raise DataGouvConnectorError("La ressource JSON ne contient ni GeoJSON ni liste d’enregistrements exploitable.")
            else:
                raise DataGouvConnectorError("La ressource JSON est invalide.")

        elif kind == "csv":
            records = self._read_csv_records(path)
            geojson = records_to_geojson({"results": records}, None)

        elif kind in {"gpkg", "shp"}:
            geojson = self._load_with_geopandas(path)

        elif kind == "zip":
            with tempfile.TemporaryDirectory(prefix="datagouv_") as temp_dir:
                temp_path = Path(temp_dir)
                with zipfile.ZipFile(path) as archive:
                    # Protection minimale contre le zip-slip.
                    for member in archive.infolist():
                        destination = (temp_path / member.filename).resolve()
                        if not str(destination).startswith(str(temp_path.resolve())):
                            raise DataGouvConnectorError("Archive ZIP non sûre.")
                    archive.extractall(temp_path)
                files = [p for p in temp_path.rglob("*") if p.is_file()]
                geojson_files = [p for p in files if p.suffix.lower() in {".geojson", ".json"}]
                csv_files = [p for p in files if p.suffix.lower() == ".csv"]
                shp_files = [p for p in files if p.suffix.lower() == ".shp"]
                gpkg_files = [p for p in files if p.suffix.lower() == ".gpkg"]
                if geojson_files:
                    payload = self._read_json(geojson_files[0])
                    direct = self._feature_collection(payload)
                    if not direct:
                        raise DataGouvConnectorError("Le fichier JSON de l’archive n’est pas un GeoJSON exploitable.")
                    geojson = direct
                elif gpkg_files:
                    geojson = self._load_with_geopandas(gpkg_files[0])
                elif shp_files:
                    geojson = self._load_with_geopandas(shp_files[0])
                elif csv_files:
                    geojson = records_to_geojson({"results": self._read_csv_records(csv_files[0])}, None)
                else:
                    raise DataGouvConnectorError("Aucun GeoJSON, CSV, GeoPackage ou Shapefile exploitable dans l’archive.")
        else:
            raise DataGouvConnectorError("Format de ressource non pris en charge.")

        features = geojson.get("features") if isinstance(geojson, dict) else None
        if not isinstance(features, list) or not features:
            raise DataGouvConnectorError(
                "La meilleure ressource a été chargée, mais aucune géométrie exploitable n’a été détectée."
            )
        return geojson, {
            "cache_hit": cache_hit,
            "cache_file": str(path),
            "resource_id": resource.get("id"),
            "resource_title": resource.get("title"),
            "resource_format": resource.get("format"),
            "resource_kind": kind,
            "resource_url": resource.get("url"),
        }
