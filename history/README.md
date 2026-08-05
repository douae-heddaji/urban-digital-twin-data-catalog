# Historique des datasets dynamiques

Ce dossier construit un historique automatique pour les datasets marqués
**"Dynamique"** dans le catalogue (17 à ce jour : VélÔToulouse ×2 + les
stations météo).

Depuis la dernière mise à jour, la capture périodique est **intégrée
directement à l'application Flask** via APScheduler (`scheduler.py`) : plus
besoin de Planificateur de tâches Windows ni de cron externe — tant que
`app.py` tourne, les captures se font automatiquement en arrière-plan.

## Comment ça marche

- `capture.py` récupère la liste des datasets "Dynamique" (même source que
  le catalogue), interroge l'API Flask déjà existante (`/api/dataset/<id>`)
  pour chacun, et enregistre un instantané dans `history.db` (SQLite),
  seulement si le contenu a changé depuis le dernier instantané.
  - Pour éviter de re-télécharger tout un historique de plusieurs années à
    chaque capture (cas des stations météo), il demande d'abord la date la
    plus récente et fiable du dataset (`/api/dataset-temporal-range`), puis
    ne récupère que cette date-là.
  - Si un dataset n'a aucune géométrie propre (ex. VélÔToulouse
    "Disponibilité temps réel", qui doit être croisé avec le dataset de
    localisation des stations), la capture se rabat automatiquement sur la
    jointure la plus fiable détectée (même mécanisme que le bouton
    "Visualiser directement" de la carte).
- `scheduler.py` déclenche `capture.run()` à intervalle régulier
  (15 minutes par défaut) via un `BackgroundScheduler` APScheduler démarré
  au lancement de `app.py`. Une seule capture à la fois (`max_instances=1`) :
  si une capture prend plus de temps que l'intervalle, la suivante attend
  plutôt que de se lancer par-dessus.
- Chaque enregistrement capturé reçoit deux nouveaux attributs,
  **`_capture_date`** et **`_capture_heure`**, assignés par le script au
  moment de la capture — jamais lus dans les données elles-mêmes. Ça
  fonctionne donc même pour un dataset qui n'a lui-même aucun attribut de
  date ou d'heure.
- "Passé" = tout ce qui a été capturé depuis que l'application tourne.
  "Futur" = la capture continue indéfiniment tant que le serveur est démarré
  — aucune donnée n'est prédite, seule la capture continue.

## Mise en route

Rien à faire : dès que tu lances `app.py` normalement (`python app.py`), le
planificateur démarre automatiquement et crée `history/history.db` à la
première capture. La console affiche `[historique] Capture automatique
démarrée (toutes les 15 min).` au démarrage.

### Réglages (optionnels, via variables d'environnement)

- `HISTORY_CAPTURE_INTERVAL_MINUTES` — change l'intervalle (défaut : 15).
- `HISTORY_SCHEDULER_ENABLED=0` — désactive complètement la capture
  automatique (utile en développement si tu ne veux pas solliciter l'API à
  chaque redémarrage).

### Vérifier que ça tourne

- `GET /api/history-scheduler/status` — état actuel : activé ou non,
  intervalle, dernière/prochaine exécution, résumé de la dernière capture
  (nombre de datasets, erreurs éventuelles par dataset).
- `POST /api/history-scheduler/run-now` — déclenche une capture immédiate
  sans attendre l'intervalle (pratique pour tester). Répond une fois la
  capture terminée.

## Solution de repli (planification externe)

`capture.py` reste utilisable seul si tu préfères revenir à une
planification externe (ex. sur un vrai serveur où Flask tournerait via un
gestionnaire de process séparé) :
```
cd history
python capture.py
```

**Windows (Planificateur de tâches)** : Créer une tâche de base → Action
"Démarrer un programme" → Programme : ton `python.exe` → Arguments :
`capture.py` → Démarrer dans : ce dossier `history/`.

**Linux/Mac (cron)** :
```
*/15 * * * * cd /chemin/vers/history && /usr/bin/python3 capture.py >> capture.log 2>&1
```

Dans ce cas, désactive le planificateur intégré (`HISTORY_SCHEDULER_ENABLED=0`)
pour éviter une double capture.

## Consulter l'historique

- `GET /api/dataset-history/<dataset_id>/dates` — liste toutes les dates de
  capture disponibles pour un dataset.
- `GET /api/dataset-history/<dataset_id>?date=AAAA-MM-JJ&time=HH:MM` —
  renvoie l'instantané le plus proche de cette date/heure (ou le plus
  récent si aucune date n'est fournie).

Ces deux routes existent déjà côté Flask ; il reste à les relier à
l'interface de la carte (un sélecteur "Historique" à côté des paramètres
temporels actuels) si tu veux les utiliser visuellement — dis-le si tu veux
qu'on l'ajoute.
