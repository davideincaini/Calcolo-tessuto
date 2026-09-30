"""
calc_reference.py — implementazione di riferimento dei calcoli di Trama (v2).

Perché esiste un doppione Python del file docs/calc.js?
    L'app gira nel browser dell'iPhone, quindi i calcoli DEVONO essere in
    JavaScript (GitHub Pages serve solo file statici, niente Python lato server).
    Questo file è la versione che si legge e si verifica comodamente in Python,
    e che puoi importare nei notebook. test_calc.py esegue entrambe le versioni
    sugli stessi ingressi e fallisce se danno numeri diversi.

Regola di manutenzione: ogni modifica a una formula va fatta in ENTRAMBI i file.

Unità (identiche a calc.js):
    titolo T ....... tex (g / 1000 m)      densità ρ ..... g/cm³
    fili n ......... fili/cm               grammatura .... g/m²
    lunghezze ...... mm                    crimp, quote, Vf, tolleranze: frazioni

Convenzione armature: M[i][j], i = ordito, j = trama, 1 = ordito sopra (diritto).
"""

from __future__ import annotations

import math

SHAPE_FACTORS = {
    "rect": 1.0,
    "ellipse": math.pi / 4,
    "lens": 2.0 / 3.0,
}

VF_MAX_HEX = math.pi / (2 * math.sqrt(3))


# -----------------------------------------------------------------------------
# Armature
# -----------------------------------------------------------------------------

def plain_matrix() -> list[list[int]]:
    """Tela: scacchiera 2×2, ogni filo cambia lato a ogni incrocio."""
    return [[1, 0], [0, 1]]


def twill_matrix(up: int, down: int) -> list[list[int]]:
    """Saia up/down: ordito sopra se (j − i) mod R < up. Il modulo di Python
    è già sempre positivo, a differenza di % in JavaScript (che lì va corretto)."""
    R = up + down
    return [[1 if (j - i) % R < up else 0 for j in range(R)] for i in range(R)]


def satin_matrix(offsets: list[int]) -> list[list[int]]:
    """Satin a effetto ordito: l'ordito i passa sotto la sola trama offsets[i]."""
    R = len(offsets)
    return [[0 if j == offsets[i] else 1 for j in range(R)] for i in range(R)]


def regular_satin_offsets(R: int, s: int) -> list[int]:
    """Satin regolare: posizione della legatura = (s · i) mod R."""
    return [(s * i) % R for i in range(R)]


# Stesso ordine e stesse chiavi di WEAVES in calc.js.
WEAVES = {
    "plain":   {"label": "Plain (tela)",      "short": "Plain",     "build": plain_matrix},
    "twill22": {"label": "Twill 2×2 (saia)",  "short": "Twill 2×2", "build": lambda: twill_matrix(2, 2)},
    "twill44": {"label": "Twill 4×4 (saia)",  "short": "Twill 4×4", "build": lambda: twill_matrix(4, 4)},
    "satin4":  {"label": "Satin 4H crowfoot", "short": "4H",        "build": lambda: satin_matrix([0, 1, 3, 2])},
    "satin5":  {"label": "Satin 5H",          "short": "5H",        "build": lambda: satin_matrix(regular_satin_offsets(5, 2))},
    "satin8":  {"label": "Satin 8H",          "short": "8H",        "build": lambda: satin_matrix(regular_satin_offsets(8, 3))},
}
WEAVE_ORDER = list(WEAVES)


def weave_matrix(weave_id: str) -> list[list[int]] | None:
    w = WEAVES.get(weave_id)
    return w["build"]() if w else None


def cyclic_runs(seq: list[int]) -> dict:
    """Cambi di lato e flottazione massima di una sequenza CICLICA di 0/1."""
    n = len(seq)
    transitions = sum(1 for k in range(n) if seq[k] != seq[(k + 1) % n])
    if transitions == 0:
        return {"transitions": 0, "max_run": math.inf}
    # Partenza su un punto di cambio, così nessuna flottazione è spezzata in due.
    start = 0
    while seq[start] == seq[(start - 1) % n]:
        start += 1
    max_run = run = 0
    for k in range(n):
        a = seq[(start + k) % n]
        prev = seq[(start + k - 1) % n]
        run = 1 if k == 0 or a != prev else run + 1
        max_run = max(max_run, run)
    return {"transitions": transitions, "max_run": max_run}


def weave_stats(M: list[list[int]]) -> dict:
    """Metriche adimensionali di un'armatura, dalla sola matrice (vedi calc.js)."""
    Rw, Rp = len(M), len(M[0])
    t_warp = t_weft = f_warp = f_weft = ones = 0
    for i in range(Rw):
        r = cyclic_runs(M[i])
        t_warp += r["transitions"]
        f_warp = max(f_warp, r["max_run"])
        ones += sum(M[i])
    for j in range(Rp):
        r = cyclic_runs([1 - M[i][j] for i in range(Rw)])
        t_weft += r["transitions"]
        f_weft = max(f_weft, r["max_run"])
    cells = Rw * Rp
    return {
        "repeat_warp": Rw,
        "repeat_weft": Rp,
        "interlacing_warp": t_warp / cells,
        "interlacing_weft": t_weft / cells,
        "float_max_warp": f_warp,
        "float_max_weft": f_weft,
        "bindings_per_repeat": t_warp / 2,
        "warp_face": ones / cells,
    }


# -----------------------------------------------------------------------------
# Relazioni elementari
# -----------------------------------------------------------------------------

def fiber_area(tex: float, rho: float) -> float:
    """Area di sola fibra nella sezione del filo [mm²]: A = tex / (1000 · ρ)."""
    return tex / (1000.0 * rho)


def tex_from_geometry(filaments: int, diameter_um: float, rho: float) -> float:
    """tex = 10⁻³·ρ·ΣA_i; caso particolare N filamenti circolari: ΣA_i = N·π·d²/4."""
    d_mm = diameter_um / 1000.0
    area = filaments * math.pi * d_mm ** 2 / 4.0  # mm²
    return area * 1000.0 * rho


def equivalent_diameter_um(tex: float, filaments: int, rho: float) -> float:
    """Diametro di filamento che rende coerenti tex, N e ρ [µm]."""
    area_per_filament = fiber_area(tex, rho) / filaments
    return math.sqrt(4.0 * area_per_filament / math.pi) * 1000.0


def faw_from_n(n: float, tex: float, crimp: float) -> float:
    """FAW_dir = n · T · (1 + c) / 10  [g/m²]."""
    return n * tex * (1.0 + crimp) / 10.0


def n_from_faw(faw_dir: float, tex: float, crimp: float) -> float:
    """n = 10 · FAW_dir / (T · (1 + c))  [fili/cm]."""
    return 10.0 * faw_dir / (tex * (1.0 + crimp))


def pitch_mm(n: float) -> float | None:
    return 10.0 / n if n > 0 else None


def implied_crimp(faw_meas, n_warp, tex_warp, n_weft, tex_weft) -> float | None:
    """c = 10·FAW_misurata / (n_o·T_o + n_t·T_t) − 1 (crimp uguale nelle due direzioni)."""
    base = n_warp * tex_warp + n_weft * tex_weft
    return 10.0 * faw_meas / base - 1.0 if base > 0 else None


def yarn_geometry(tex, rho, n, vf_yarn, shape_k, w_meas=None) -> dict | None:
    if not n > 0:
        return None
    af = fiber_area(tex, rho)
    ay = af / vf_yarn
    p = pitch_mm(n)
    t_req = ay / (shape_k * p)
    g = {
        "af": af,
        "ay": ay,
        "pitch": p,
        "per_inch": n * 2.54,
        "w_req": p,
        "t_req": t_req,
        "ar_req": p / t_req,
        "w_meas": None,
        "cover": None,
        "gap": None,
        "t_meas": None,
        "ar_meas": None,
        "spread_factor": None,
    }
    if w_meas is not None and w_meas > 0:
        g["w_meas"] = w_meas
        g["cover"] = w_meas / p
        g["gap"] = p - w_meas
        g["t_meas"] = ay / (shape_k * w_meas)
        g["ar_meas"] = w_meas / g["t_meas"]
        g["spread_factor"] = p / w_meas
    return g


def fabric_cover(c_warp: float, c_weft: float) -> float:
    a = min(c_warp, 1.0)
    b = min(c_weft, 1.0)
    return a + b - a * b


# -----------------------------------------------------------------------------
# Validazione (stessi messaggi di calc.js: i test confrontano anche questi)
# -----------------------------------------------------------------------------

def _is_pos(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0


def _is_non_neg(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x >= 0


def validate(inp: dict) -> str | None:
    if inp.get("weave") not in WEAVES:
        return "Armatura non riconosciuta."
    if inp.get("shape") not in SHAPE_FACTORS:
        return "Forma della sezione non riconosciuta."
    for label, y in (("ordito", inp.get("warp")), ("trama", inp.get("weft"))):
        if not y or not _is_pos(y.get("tex")):
            return f"Titolo (tex) del filo di {label} mancante."
        if not _is_pos(y.get("rho")):
            return f"Densità della fibra di {label} mancante."
    if not _is_pos(inp.get("vf_yarn")) or inp["vf_yarn"] > VF_MAX_HEX:
        return "Il Vf nel filo deve stare tra 0 e 0,907 (limite dell'impaccamento esagonale)."
    if not _is_pos(inp.get("vf_lam")) or inp["vf_lam"] > VF_MAX_HEX:
        return "Il Vf del laminato deve stare tra 0 e 0,907."
    if not _is_non_neg(inp.get("crimp_warp")) or not _is_non_neg(inp.get("crimp_weft")):
        return "Il crimp non può essere negativo."
    if not _is_non_neg(inp.get("tex_tol")) or inp["tex_tol"] >= 1:
        return "La tolleranza sul tex deve stare tra 0 e 100 %."
    mode = inp.get("mode")
    if mode == "faw":
        if not _is_pos(inp.get("faw_target")):
            return "Inserisci una grammatura obiettivo maggiore di zero."
        if not _is_non_neg(inp.get("warp_share")) or inp["warp_share"] > 1:
            return "La quota in ordito deve stare tra 0 e 100 %."
    elif mode == "density":
        if not _is_non_neg(inp.get("n_warp")) or not _is_non_neg(inp.get("n_weft")):
            return "Le densità (fili/cm) non possono essere negative."
        if inp["n_warp"] + inp["n_weft"] == 0:
            return "Inserisci almeno una densità maggiore di zero."
    else:
        return "Modalità di calcolo non riconosciuta."
    return None


def _add_weave_geometry(warp, weft, st) -> None:
    if warp and weft:
        warp["float_max_mm"] = st["float_max_warp"] * weft["pitch"]
        weft["float_max_mm"] = st["float_max_weft"] * warp["pitch"]
        warp["repeat_mm"] = st["repeat_weft"] * weft["pitch"]
        weft["repeat_mm"] = st["repeat_warp"] * warp["pitch"]
        warp["transitions_cm"] = st["interlacing_warp"] * (10.0 / weft["pitch"])
        weft["transitions_cm"] = st["interlacing_weft"] * (10.0 / warp["pitch"])
    for g in (warp, weft):
        if g is not None and "float_max_mm" not in g:
            g["float_max_mm"] = None
            g["repeat_mm"] = None
            g["transitions_cm"] = None


# -----------------------------------------------------------------------------
# Punto d'ingresso unico, stesso contratto di FabricCalc.compute() in JS
# -----------------------------------------------------------------------------

def compute(inp: dict) -> dict:
    err = validate(inp)
    if err:
        return {"error": err}

    k = SHAPE_FACTORS[inp["shape"]]
    if inp["mode"] == "faw":
        faw_warp = inp["faw_target"] * inp["warp_share"]
        faw_weft = inp["faw_target"] * (1.0 - inp["warp_share"])
        n_warp = n_from_faw(faw_warp, inp["warp"]["tex"], inp["crimp_warp"])
        n_weft = n_from_faw(faw_weft, inp["weft"]["tex"], inp["crimp_weft"])
    else:
        n_warp = inp["n_warp"]
        n_weft = inp["n_weft"]
        faw_warp = faw_from_n(n_warp, inp["warp"]["tex"], inp["crimp_warp"])
        faw_weft = faw_from_n(n_weft, inp["weft"]["tex"], inp["crimp_weft"])

    faw = faw_warp + faw_weft
    warp = yarn_geometry(inp["warp"]["tex"], inp["warp"]["rho"], n_warp,
                         inp["vf_yarn"], k, inp.get("w_meas_warp"))
    weft = yarn_geometry(inp["weft"]["tex"], inp["weft"]["rho"], n_weft,
                         inp["vf_yarn"], k, inp.get("w_meas_weft"))

    st = weave_stats(weave_matrix(inp["weave"]))
    _add_weave_geometry(warp, weft, st)

    cover = None
    if warp and weft and warp["cover"] is not None and weft["cover"] is not None:
        cover = fabric_cover(warp["cover"], weft["cover"])

    ply = (faw_warp / inp["warp"]["rho"] + faw_weft / inp["weft"]["rho"]) / (1000.0 * inp["vf_lam"])

    bindings = None
    if n_warp > 0 and n_weft > 0:
        bindings = st["bindings_per_repeat"] / (st["repeat_warp"] * st["repeat_weft"]) * n_warp * n_weft

    crimp_imp = None
    if inp["mode"] == "density" and _is_pos(inp.get("faw_meas")):
        crimp_imp = implied_crimp(inp["faw_meas"], n_warp, inp["warp"]["tex"], n_weft, inp["weft"]["tex"])

    return {
        "error": None,
        "n_warp": n_warp,
        "n_weft": n_weft,
        "faw": faw,
        "faw_warp": faw_warp,
        "faw_weft": faw_weft,
        "faw_min": faw * (1.0 - inp["tex_tol"]),
        "faw_max": faw * (1.0 + inp["tex_tol"]),
        "shape_k": k,
        "warp": warp,
        "weft": weft,
        "cover_fabric": cover,
        "weave": {"id": inp["weave"], **st},
        "bindings_cm2": bindings,
        "ply_thickness": ply,
        "ends_per_m": n_warp * 100,
        "picks_per_m": n_weft * 100,
        "crimp_implied": crimp_imp,
    }


def base_input(**over) -> dict:
    """Ingresso tipico, comodo nei notebook: cambia solo ciò che serve."""
    inp = {
        "mode": "faw", "faw_target": 280.0, "warp_share": 0.5,
        "n_warp": 0.0, "n_weft": 0.0, "faw_meas": None,
        "warp": {"tex": 198.0, "rho": 1.76}, "weft": {"tex": 198.0, "rho": 1.76},
        "crimp_warp": 0.0, "crimp_weft": 0.0, "tex_tol": 0.03,
        "vf_yarn": 0.70, "vf_lam": 0.55, "shape": "rect", "weave": "satin5",
        "w_meas_warp": None, "w_meas_weft": None,
    }
    inp.update(over)
    return inp


if __name__ == "__main__":
    # Il confronto della discussione: 280 g/m² 5H, filato da 360 tex contro 223 tex.
    for name, tex, rho in (("6K 360 tex, 6,5 µm", 360.0, 1.78), ("6K 223 tex, 5 µm", 223.0, 1.81)):
        r = compute(base_input(warp={"tex": tex, "rho": rho}, weft={"tex": tex, "rho": rho}))
        print(f"{name}: {r['n_warp']:.3f} fili/cm, passo {r['warp']['pitch']:.2f} mm, "
              f"rapporto {r['warp']['repeat_mm']:.1f} mm, flottazione {r['warp']['float_max_mm']:.1f} mm, "
              f"legature {r['bindings_cm2']:.1f}/cm², ply {r['ply_thickness']:.3f} mm")
    print()
    for wid in WEAVE_ORDER:
        s = weave_stats(weave_matrix(wid))
        print(f"{WEAVES[wid]['label']:<20} R={s['repeat_warp']}  indice={s['interlacing_warp']:.2f}  "
              f"flottazione max={s['float_max_warp']}  faccia ordito={s['warp_face']:.0%}")
