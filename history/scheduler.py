"""
Planificateur intégré pour la capture périodique de l'historique des
datasets dynamiques.

Remplace le Planificateur de tâches Windows / cron externe : tant que le
serveur Flask (`app.py`) tourne, ce module déclenche automatiquement
`history.capture.run()` à intervalle régulier, en arrière-plan, sans bloquer
les requêtes normales de l'application.

`history/capture.py` reste utilisable seul (`python capture.py`) si jamais
un déclenchement externe est préféré à nouveau plus tard — ce module ne fait
qu'appeler la même fonction `run()`, sans dupliquer sa logique.
"""

from __future__ import annotations

import os
import threading
from datetime import datetime
from typing import Any, Optional

from apscheduler.schedulers.background import BackgroundScheduler

from . import capture

# --- Configuration -----------------------------------------------------------

# Intervalle entre deux captures, en minutes. Modifiable aussi via la
# variable d'environnement HISTORY_CAPTURE_INTERVAL_MINUTES sans toucher au
# code (utile pour resserrer l'intervalle en test, ou l'espacer en prod).
DEFAULT_INTERVAL_MINUTES = 1


# Pour désactiver complètement la capture automatique sans rien enlever au
# code : variable d'environnement HISTORY_SCHEDULER_ENABLED=0
ENABLED = os.environ.get("HISTORY_SCHEDULER_ENABLED", "1") != "0"


def _interval_minutes() -> int:
    """Assure le traitement associé à « interval minutes »."""
    raw = os.environ.get("HISTORY_CAPTURE_INTERVAL_MINUTES")
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return DEFAULT_INTERVAL_MINUTES


# --- État exposé (pour un éventuel affichage/diagnostic) ---------------------

_state_lock = threading.Lock()
_state: dict[str, Any] = {
    "enabled": ENABLED,
    "interval_minutes": _interval_minutes(),
    "running": False,
    "last_run_at": None,
    "last_result": None,   # dernier résumé retourné par capture.run()
    "last_error": None,    # erreur inattendue (hors gestion déjà faite par capture.run())
    "run_count": 0,
}

_scheduler: Optional[BackgroundScheduler] = None


def get_status() -> dict[str, Any]:
    """Snapshot de l'état courant du planificateur (thread-safe)."""
    with _state_lock:
        status = dict(_state)
    if _scheduler is not None and _scheduler.running:
        jobs = _scheduler.get_jobs()
        if jobs:
            next_run = jobs[0].next_run_time
            status["next_run_at"] = next_run.isoformat(timespec="seconds") if next_run else None
    else:
        status["next_run_at"] = None
    return status


def _run_capture_job() -> None:
    """Exécute une capture et journalise le résultat dans l'état partagé.
    Ne lève jamais d'exception (APScheduler désactiverait le job sinon) :
    toute erreur imprévue est capturée et exposée via get_status()."""
    with _state_lock:
        _state["running"] = True
    try:
        result = capture.run()
        with _state_lock:
            _state["last_result"] = result
            _state["last_error"] = None
    except Exception as exc:  # défense en profondeur : capture.run() gère déjà
        # ses propres erreurs dataset par dataset, mais on ne veut jamais que
        # le planificateur s'arrête pour une raison imprévue.
        with _state_lock:
            _state["last_error"] = str(exc)
    finally:
        with _state_lock:
            _state["running"] = False
            _state["last_run_at"] = datetime.now().isoformat(timespec="seconds")
            _state["run_count"] += 1


def start(run_immediately: bool = False) -> Optional[BackgroundScheduler]:
    """Démarre le planificateur si activé et pas déjà démarré. Sûr à appeler
    plusieurs fois (idempotent) : un second appel est ignoré."""
    global _scheduler

    if not ENABLED:
        print("[historique] Capture automatique désactivée (HISTORY_SCHEDULER_ENABLED=0).")
        return None

    if _scheduler is not None:
        return _scheduler

    interval = _interval_minutes()
    _scheduler = BackgroundScheduler(daemon=True)
    job_kwargs: dict[str, Any] = dict(
        trigger="interval",
        minutes=interval,
        id="history_capture",
        # Une seule exécution à la fois : si une capture dépasse l'intervalle
        # (beaucoup de datasets, API lente...), on ne la relance pas par-dessus.
        max_instances=1,
        coalesce=True,
    )
    if run_immediately:
        job_kwargs["next_run_time"] = datetime.now()
    # Important : si run_immediately est False, on NE PASSE PAS next_run_time
    # du tout (plutôt que de passer None). Pour APScheduler, next_run_time=None
    # explicite signifie "mettre le job en pause indéfiniment", pas "laisser le
    # déclencheur calculer normalement le prochain passage" — la capture ne se
    # déclenchait donc jamais avant ce correctif.
    _scheduler.add_job(_run_capture_job, **job_kwargs)
    _scheduler.start()
    print(f"[historique] Capture automatique démarrée (toutes les {interval} min).")
    return _scheduler


def shutdown() -> None:
    """Assure le traitement associé à « shutdown »."""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
