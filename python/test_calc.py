"""
test_calc.py — test dei calcoli, delle armature e del database.

Esecuzione (dalla radice del repo):   python -m pytest python -v

Cosa verifichiamo, dal più concreto al più astratto:
  1) casi reali noti (3K 7×7, il confronto 360 tex / 223 tex a 280 g/m² 5H);
  2) armature: proprietà che un tessitore riconoscerebbe a colpo d'occhio;
  3) identità ricavate a mano (andata e ritorno, spessore indipendente dal tex);
  4) che docs/calc.js (quello che gira sull'iPhone) dia gli STESSI numeri
     di calc_reference.py su centinaia di ingressi casuali;
  5) che il database non contenga valori impossibili o duplicati.
"""

import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

import calc_reference as C
import db_tools

ROOT = Path(__file__).resolve().parent.parent
CALC_JS = ROOT / "docs" / "calc.js"
HAS_NODE = shutil.which("node") is not None

base_input = C.base_input  # stesso ingresso tipico usato nei notebook


def run_node(expr_js: str, payload):
    """Esegue calc.js in Node: `expr_js` riceve `calc` e `x` (il payload) e
    deve restituire un valore serializzabile in JSON."""
    runner = (
        f"const calc = require({json.dumps(str(CALC_JS))});"
        "let s='';process.stdin.on('data',d=>s+=d);"
        "process.stdin.on('end',()=>{const x=JSON.parse(s);"
        f"process.stdout.write(JSON.stringify(({expr_js})(calc, x)));}});"
    )
    proc = subprocess.run(["node", "-e", runner], input=json.dumps(payload),
                          capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


# -----------------------------------------------------------------------------
# 1) Casi reali
# -----------------------------------------------------------------------------

def test_3k_7x7_con_crimp_1_percento():
    # 7 × 198 × 2 / 10 = 277,2 g/m²; con l'1 % di crimp ≈ 280 (il 5H 3K da catalogo)
    r = C.compute(base_input(mode="density", n_warp=7.0, n_weft=7.0,
                             crimp_warp=0.01, crimp_weft=0.01))
    assert r["faw"] == pytest.approx(279.972)


def test_confronto_360_223_tex_a_280_5H():
    # I numeri della discussione da cui è nata l'app (crimp nullo).
    r1 = C.compute(base_input(warp={"tex": 360.0, "rho": 1.78}, weft={"tex": 360.0, "rho": 1.78}))
    r2 = C.compute(base_input(warp={"tex": 223.0, "rho": 1.81}, weft={"tex": 223.0, "rho": 1.81}))
    assert r1["n_warp"] == pytest.approx(5 * 280 / 360)       # 3,889 fili/cm
    assert r2["n_warp"] == pytest.approx(5 * 280 / 223)       # 6,278 fili/cm
    assert r1["warp"]["repeat_mm"] == pytest.approx(5 * 10 / (5 * 280 / 360))  # ≈ 12,9 mm
    assert r1["bindings_cm2"] == pytest.approx(r1["n_warp"] ** 2 / 5)          # ≈ 3,0 /cm²
    assert r2["bindings_cm2"] == pytest.approx(r2["n_warp"] ** 2 / 5)          # ≈ 7,9 /cm²
    assert r1["ply_thickness"] == pytest.approx(280 / (1.78 * 1000 * 0.55))    # 0,286 mm


def test_crimp_implicito_ritrova_il_crimp_vero():
    # Grammatura "misurata" costruita con l'1,2 % di crimp: il calcolo inverso lo ritrova.
    faw_meas = 2 * 7.0 * 198.0 * 1.012 / 10
    r = C.compute(base_input(mode="density", n_warp=7.0, n_weft=7.0, faw_meas=faw_meas))
    assert r["crimp_implied"] == pytest.approx(0.012)


# -----------------------------------------------------------------------------
# 2) Armature
# -----------------------------------------------------------------------------

@pytest.mark.parametrize("wid, R, indice, flott, faccia", [
    ("plain", 2, 1.0, 1, 0.5),
    ("twill22", 4, 0.5, 2, 0.5),
    ("twill44", 8, 0.25, 4, 0.5),
    ("satin4", 4, 0.5, 3, 0.75),
    ("satin5", 5, 0.4, 4, 0.8),
    ("satin8", 8, 0.25, 7, 0.875),
])
def test_metriche_armature(wid, R, indice, flott, faccia):
    s = C.weave_stats(C.weave_matrix(wid))
    assert s["repeat_warp"] == s["repeat_weft"] == R
    assert s["interlacing_warp"] == pytest.approx(indice)
    assert s["interlacing_weft"] == pytest.approx(indice)
    assert s["float_max_warp"] == s["float_max_weft"] == flott
    assert s["warp_face"] == pytest.approx(faccia)


@pytest.mark.parametrize("wid", ["satin4", "satin5", "satin8"])
def test_satin_una_legatura_per_filo_e_per_trama(wid):
    # In un satin ogni ordito e ogni trama hanno UNA sola legatura per rapporto.
    M = C.weave_matrix(wid)
    R = len(M)
    assert all(sum(1 - v for v in col) == 1 for col in M)                      # per ordito
    assert all(sum(1 - M[i][j] for i in range(R)) == 1 for j in range(R))      # per trama


@pytest.mark.parametrize("wid", ["satin5", "satin8"])
def test_satin_regolari_legature_non_adiacenti(wid):
    # Nei satin regolari due legature vicine non si toccano nemmeno in diagonale:
    # è ciò che li distingue da una saia (dove formano la diagonale continua).
    M = C.weave_matrix(wid)
    R = len(M)
    pos = [M[i].index(0) for i in range(R)]
    for i in range(R):
        d = abs(pos[(i + 1) % R] - pos[i])
        assert min(d, R - d) >= 2


def test_crowfoot_e_una_saia_spezzata():
    # Il 4H non può essere regolare: tra fili vicini le legature si toccano in
    # diagonale, ma la diagonale cambia verso (saia 3/1 "spezzata").
    M = C.weave_matrix("satin4")
    pos = [col.index(0) for col in M]
    steps = [(pos[(i + 1) % 4] - pos[i]) % 4 for i in range(4)]
    assert 1 in steps and 3 in steps


def test_flottazione_ciclica_scavalca_il_bordo():
    # 1,1,0,1 ciclico: la flottazione di 1 è lunga 3 (l'ultimo si unisce ai primi due).
    assert C.cyclic_runs([1, 1, 0, 1]) == {"transitions": 2, "max_run": 3}


def test_armatura_non_valida():
    assert "Armatura" in C.compute(base_input(weave="raso9"))["error"]


# -----------------------------------------------------------------------------
# 3) Identità ricavate a mano
# -----------------------------------------------------------------------------

@pytest.mark.parametrize("tex", [66, 198, 400, 800, 1650, 3745])
def test_spessore_a_copertura_piena_non_dipende_dal_tex(tex):
    # t = A_f/(Vf·p) con n = 5·FAW/T  ⇒  t = FAW/(2000·ρ·Vf): il tex si semplifica.
    rho, vf, faw = 1.80, 0.70, 280.0
    r = C.compute(base_input(warp={"tex": tex, "rho": rho}, weft={"tex": tex, "rho": rho},
                             vf_yarn=vf, faw_target=faw))
    assert r["warp"]["t_req"] == pytest.approx(faw / (2000 * rho * vf))


def test_andata_e_ritorno():
    inp = base_input(warp_share=0.7, crimp_warp=0.02, crimp_weft=0.005,
                     weft={"tex": 800.0, "rho": 1.80})
    r1 = C.compute(inp)
    r2 = C.compute(base_input(mode="density", n_warp=r1["n_warp"], n_weft=r1["n_weft"],
                              crimp_warp=0.02, crimp_weft=0.005,
                              weft={"tex": 800.0, "rho": 1.80}))
    assert r2["faw"] == pytest.approx(280.0)
    assert r2["faw_warp"] / r2["faw"] == pytest.approx(0.7)


def test_armatura_non_cambia_grammatura_ne_fili():
    # L'armatura entra nei fili/cm solo tramite il crimp (che è un ingresso):
    # a crimp fisso, tela e 8H danno gli stessi fili/cm.
    a = C.compute(base_input(weave="plain"))
    b = C.compute(base_input(weave="satin8"))
    assert a["n_warp"] == pytest.approx(b["n_warp"])
    assert a["ply_thickness"] == pytest.approx(b["ply_thickness"])


def test_sbilanciato_flottazioni_usano_il_passo_dell_altra_direzione():
    r = C.compute(base_input(weft={"tex": 800.0, "rho": 1.80}, weave="satin5"))
    assert r["warp"]["float_max_mm"] == pytest.approx(4 * r["weft"]["pitch"])
    assert r["weft"]["float_max_mm"] == pytest.approx(4 * r["warp"]["pitch"])


def test_direzione_assente():
    r = C.compute(base_input(warp_share=1.0))
    assert r["weft"] is None and r["n_weft"] == 0
    assert r["bindings_cm2"] is None
    assert r["warp"]["float_max_mm"] is None


@pytest.mark.parametrize("over, frammento", [
    ({"vf_yarn": 0.95}, "Vf nel filo"),
    ({"vf_lam": 0}, "laminato"),
    ({"faw_target": 0}, "grammatura"),
    ({"crimp_warp": -0.01}, "crimp"),
    ({"warp": {"tex": 0, "rho": 1.8}}, "tex"),
    ({"shape": "trapezio"}, "sezione"),
])
def test_validazione(over, frammento):
    assert frammento in C.compute(base_input(**over))["error"]


# -----------------------------------------------------------------------------
# 4) JS e Python devono dare gli stessi numeri
# -----------------------------------------------------------------------------

def random_inputs(n=400, seed=42):
    """Ingressi casuali ma plausibili: stesso seme ⇒ stesso test a ogni esecuzione."""
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        out.append(base_input(
            mode=rng.choice(["faw", "density"]),
            faw_target=rng.uniform(50, 1200),
            warp_share=rng.choice([0.5, rng.uniform(0, 1), 1.0, 0.0]),
            n_warp=rng.uniform(0, 12), n_weft=rng.uniform(0, 12),
            faw_meas=rng.choice([None, rng.uniform(50, 1200)]),
            warp={"tex": rng.uniform(60, 3800), "rho": rng.uniform(1.7, 2.2)},
            weft={"tex": rng.uniform(60, 3800), "rho": rng.uniform(1.7, 2.2)},
            crimp_warp=rng.uniform(0, 0.05), crimp_weft=rng.uniform(0, 0.05),
            tex_tol=rng.uniform(0, 0.1), vf_yarn=rng.uniform(0.4, 0.9),
            vf_lam=rng.uniform(0.4, 0.7),
            shape=rng.choice(["rect", "ellipse", "lens"]),
            weave=rng.choice(C.WEAVE_ORDER),
            w_meas_warp=rng.choice([None, rng.uniform(0.3, 15)]),
            w_meas_weft=rng.choice([None, rng.uniform(0.3, 15)]),
        ))
    return out


def assert_close(a, b, path="res"):
    """Confronto ricorsivo: stesse chiavi, numeri uguali entro 1e-9 relativo."""
    if isinstance(a, dict):
        assert isinstance(b, dict) and set(a) == set(b), f"{path}: chiavi diverse {set(a) ^ set(b)}"
        for k in a:
            assert_close(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, (int, float)) and not isinstance(a, bool):
        assert b == pytest.approx(a, rel=1e-9, abs=1e-12), f"{path}: {a} ≠ {b}"
    else:
        assert a == b, f"{path}: {a!r} ≠ {b!r}"


@pytest.mark.skipif(not HAS_NODE, reason="Node.js non installato")
def test_js_uguale_a_python():
    cases = random_inputs()
    js_results = run_node("(calc, xs) => xs.map(calc.compute)", cases)
    for inp, js in zip(cases, js_results):
        assert_close(C.compute(inp), js)


@pytest.mark.skipif(not HAS_NODE, reason="Node.js non installato")
def test_matrici_armature_uguali_in_js_e_python():
    js = run_node("(calc, ids) => ids.map(calc.weaveMatrix)", C.WEAVE_ORDER)
    assert js == [C.weave_matrix(w) for w in C.WEAVE_ORDER]
    assert run_node("(calc) => calc.WEAVE_ORDER", None) == C.WEAVE_ORDER


# -----------------------------------------------------------------------------
# 5) Database
# -----------------------------------------------------------------------------

def test_database_senza_errori_bloccanti():
    assert db_tools.validate_db(db_tools.load_db()) == []


def test_database_coerenza_geometrica_entro_20_percento():
    # Oltre ~10 % è normale (diametro arrotondato in scheda); oltre 20 % è
    # quasi certamente un errore di battitura su tex, filamenti o densità.
    for rec in db_tools.load_db()["fibers"]:
        c = db_tools.consistency(rec)
        if c["deviation"] is not None:
            assert abs(c["deviation"]) < 0.20, (rec["supplier"], rec["grade"], c)
