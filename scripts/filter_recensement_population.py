"""
Filtre les fichiers Recensement Population INSEE (base-ic-evol-struct-pop-AAAA.csv)
pour ne garder que les 37 communes de Toulouse Métropole, et exporte un CSV léger
dans le dossier data/ du catalogue.

Utilisation :
    1. Placer les fichiers bruts directement dans data/ :
       - data/base-ic-evol-struct-pop-2020.csv
       - data/base-ic-evol-struct-pop-2021.csv
       - data/base-ic-evol-struct-pop-2022.csv
    2. Lancer : python scripts/filter_recensement_population.py
    3. Les CSV filtrés sont créés dans data/ (fichiers bruts conservés à côté) :
       - recensement_2020_toulouse_metropole.csv
       - recensement_2021_toulouse_metropole.csv
       - recensement_2022_toulouse_metropole.csv

Note : les fichiers INSEE "base-ic-evol-struct-pop" utilisent le séparateur ";".
Si la lecture échoue (erreur d'encodage), essayer encoding="latin-1" au lieu de "utf-8".
"""

import os
import pandas as pd

# 37 communes de Toulouse Métropole (codes INSEE)
COMMUNES_METROPOLE = [
    "31003", "31022", "31032", "31044", "31053", "31056", "31069", "31088",
    "31091", "31116", "31149", "31150", "31157", "31163", "31182", "31184",
    "31186", "31205", "31230", "31282", "31293", "31351", "31352", "31355",
    "31389", "31417", "31418", "31445", "31467", "31488", "31490", "31506",
    "31541", "31555", "31557", "31561", "31588"
]

# Années à traiter -> nom du fichier source attendu (dans data/)
FICHIERS = {
    2020: "base-ic-evol-struct-pop-2020.csv",
    2021: "base-ic-evol-struct-pop-2021.csv",
    2022: "base-ic-evol-struct-pop-2022.csv",
}

DOSSIER_DATA = os.path.join(os.path.dirname(__file__), "..", "data")


def filtrer_annee(annee, nom_fichier):
    """Filtre le fichier de recensement pour ne conserver que les données de l'année demandée."""
    chemin_source = os.path.join(DOSSIER_DATA, nom_fichier)

    if not os.path.exists(chemin_source):
        print(f"[{annee}] fichier introuvable : {chemin_source} (ignoré)")
        return

    print(f"[{annee}] lecture de {chemin_source}...")
    try:
        df = pd.read_csv(chemin_source, sep=";", dtype={"COM": str}, encoding="utf-8")
    except UnicodeDecodeError:
        df = pd.read_csv(chemin_source, sep=";", dtype={"COM": str}, encoding="latin-1")

    filtre = df[df["COM"].isin(COMMUNES_METROPOLE)]

    sortie = os.path.join(DOSSIER_DATA, f"recensement_{annee}_toulouse_metropole.csv")
    filtre.to_csv(sortie, index=False, sep=";")

    print(f"[{annee}] {len(filtre)} lignes conservées sur {len(df)} -> {sortie}")


if __name__ == "__main__":
    os.makedirs(DOSSIER_DATA, exist_ok=True)
    for annee, nom_fichier in FICHIERS.items():
        filtrer_annee(annee, nom_fichier)
