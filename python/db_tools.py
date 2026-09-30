"""
db_tools.py — funzioni per gestire docs/fibers.json senza interfaccia grafica.

Perché separare queste funzioni dall'editor tkinter?
    La logica (carica, valida, controlla la coerenza, salva) si testa con
    pytest senza aprire finestre. L'editor grafico è un sottile strato sopra
    queste funzioni: se l'editor ha un bug, i dati restano protetti dalle
    stesse regole verificate dai test.

Il file JSON è l'UNICA fonte di verità: la PWA lo legge, l'editor lo scrive.
Lo schema è lo stesso di Trama v1: un file esportato da una versione si
importa nell'altra senza conversioni.
"""

from __future__ import annotations

import json
from pathlib import Path

from calc_reference import equivalent_diameter_um, tex_from_geometry

# python/ e docs/ sono cartelle sorelle nel repository.
DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "docs" / "fibers.json"

# Campi di ogni record e tipo atteso. type(None) nel tipo = campo facoltativo.
FIELDS = {
    "supplier": str,
    "grade": str,
    "filaments": int,
    "tex": (int, float),
    "density": (int, float),
    "filament_diameter_um": (int, float, type(None)),
    "tensile_strength_mpa": (int, float, type(None)),
    "tensile_modulus_gpa": (int, float, type(None)),
    "source": str,
    "verified": bool,
    "notes": str,
}

# Intervalli plausibili per fibre di carbonio da PAN/pece. Non sono limiti
# fisici: intercettano errori di battitura (80 invece di 800, densità in kg/m³).
PLAUSIBLE = {
    "density": (1.6, 2.25),
    "filament_diameter_um": (3.0, 12.0),
    "tex_per_filament": (0.015, 0.12),  # g/km per filamento
}

# Soglia di scostamento tra tex dichiarato e tex ricavato dal diametro.
# 10 % perché il diametro in scheda è spesso arrotondato: 5,0 contro 5,2 µm
# vale già ~8 % sull'area.
CONSISTENCY_WARN = 0.10


def load_db(path: Path | str = DEFAULT_DB_PATH) -> dict:
    """Legge il JSON e restituisce il dizionario completo (con metadati)."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_db(db: dict, path: Path | str = DEFAULT_DB_PATH) -> None:
    """Scrive il JSON in modo stabile e leggibile nei diff di git.

    - ordine fisso (fornitore, grado, filamenti): git mostra solo le righe cambiate;
    - indent=2 e ensure_ascii=False: leggibile a mano, "µ" e accenti intatti;
    - scrittura su file temporaneo e poi rename: un'interruzione a metà non
      lascia il file originale troncato.
    """
    db["fibers"] = sorted(
        db["fibers"], key=lambda r: (r["supplier"].lower(), r["grade"].lower(), r["filaments"])
    )
    path = Path(path)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def record_key(rec: dict) -> tuple:
    """Chiave univoca: stesso fornitore, grado e numero di filamenti."""
    return (rec["supplier"].strip().lower(), rec["grade"].strip().lower(), int(rec["filaments"]))


def validate_record(rec: dict) -> list[str]:
    """Lista degli errori BLOCCANTI (vuota = record valido)."""
    errors = []
    for field, expected in FIELDS.items():
        if field not in rec:
            errors.append(f"campo mancante: {field}")
            continue
        value = rec[field]
        # bool è una sottoclasse di int in Python: senza questo controllo
        # True passerebbe come "1 filamento".
        if isinstance(value, bool) and field != "verified":
            errors.append(f"{field}: tipo non valido")
        elif not isinstance(value, expected):
            errors.append(f"{field}: tipo non valido ({type(value).__name__})")
    if errors:
        return errors

    if not rec["supplier"].strip() or not rec["grade"].strip():
        errors.append("fornitore e grado non possono essere vuoti")
    if rec["filaments"] <= 0:
        errors.append("il numero di filamenti deve essere positivo")
    if rec["tex"] <= 0:
        errors.append("il tex deve essere positivo")

    lo, hi = PLAUSIBLE["density"]
    if not lo <= rec["density"] <= hi:
        errors.append(f"densità {rec['density']} fuori dall'intervallo plausibile {lo}–{hi} g/cm³")

    d = rec["filament_diameter_um"]
    if d is not None:
        lo, hi = PLAUSIBLE["filament_diameter_um"]
        if not lo <= d <= hi:
            errors.append(f"diametro {d} µm fuori dall'intervallo plausibile {lo}–{hi} µm")

    if rec["filaments"] > 0 and rec["tex"] > 0:
        lo, hi = PLAUSIBLE["tex_per_filament"]
        tpf = rec["tex"] / rec["filaments"]
        if not lo <= tpf <= hi:
            errors.append(f"tex per filamento {tpf:.4f} fuori da {lo}–{hi}: controlla tex o filamenti")
    return errors


def consistency(rec: dict) -> dict:
    """Confronta il tex dichiarato con quello atteso dalla geometria dei filamenti.

    Uno scostamento alto non è un errore: spesso il diametro in scheda è
    arrotondato. Per questo restituiamo anche il diametro equivalente, il dato
    più informativo: "per essere coerente, d dovrebbe valere X µm".
    """
    d_eq = equivalent_diameter_um(rec["tex"], rec["filaments"], rec["density"])
    d = rec.get("filament_diameter_um")
    if d is None:
        return {"deviation": None, "d_equivalent_um": d_eq, "warn": False}
    tex_geo = tex_from_geometry(rec["filaments"], d, rec["density"])
    deviation = (tex_geo - rec["tex"]) / rec["tex"]
    return {"deviation": deviation, "d_equivalent_um": d_eq, "warn": abs(deviation) > CONSISTENCY_WARN}


def validate_db(db: dict) -> list[str]:
    """Errori a livello di database: record non validi e duplicati."""
    problems = []
    seen = {}
    for i, rec in enumerate(db.get("fibers", [])):
        for e in validate_record(rec):
            problems.append(f"record {i} ({rec.get('supplier')} {rec.get('grade')}): {e}")
        try:
            key = record_key(rec)
        except (KeyError, TypeError, ValueError):
            continue
        if key in seen:
            problems.append(f"record {i} duplica il record {seen[key]}: {key}")
        seen[key] = i
    return problems


def consistency_report(db: dict) -> list[tuple[dict, dict]]:
    """Coppie (record, esito) per i soli record con scostamento sopra soglia."""
    return [(rec, c) for rec in db.get("fibers", []) if (c := consistency(rec))["warn"]]


if __name__ == "__main__":
    # Uso da riga di comando: python db_tools.py  → controlla il database.
    db = load_db()
    problems = validate_db(db)
    print(f"{len(db['fibers'])} record, {len(problems)} errori bloccanti")
    for p in problems:
        print("  ERRORE:", p)
    for rec, c in consistency_report(db):
        print(f"  attenzione: {rec['supplier']} {rec['grade']} {rec['filaments'] / 1000:g}K — "
              f"tex da diametro {c['deviation']:+.1%}, d equivalente {c['d_equivalent_um']:.2f} µm")
