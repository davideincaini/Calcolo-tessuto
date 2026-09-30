/* =============================================================================
 * calc.js — motore di calcolo di Trama (v2, con armature)
 * -----------------------------------------------------------------------------
 * Qui vivono SOLO le formule, separate dall'interfaccia (app.js). Motivi:
 *   1) si possono testare da sole, anche da Python tramite Node
 *      (python/test_calc.py confronta questo file con calc_reference.py);
 *   2) l'interfaccia può cambiare senza toccare la fisica;
 *   3) python/calc_reference.py è la "copia leggibile" di questo file:
 *      se i due danno numeri diversi, i test falliscono.
 *
 * Contratto dati: ingressi e uscite di compute() usano chiavi snake_case
 * (faw_target, n_warp, ...) identiche alle chiavi del dizionario Python.
 * Un solo vocabolario per due linguaggi = meno errori di traduzione.
 *
 * Unità, fisse in tutto il file:
 *   titolo T ........ tex  (g / 1000 m)
 *   densità ρ ....... g/cm³
 *   fili n .......... fili/cm
 *   grammatura FAW .. g/m²
 *   lunghezze ....... mm
 *   crimp, quote, Vf, tolleranze ... frazioni (0.01 = 1 %)
 *
 * Convenzione delle armature: matrice M[i][j], i = filo di ordito (colonna),
 * j = filo di trama (riga). M = 1 se in quell'incrocio l'ORDITO sta sopra,
 * vista dal diritto del tessuto. È la "carta tecnica" del tessitore.
 * ===========================================================================*/

(function (root, factory) {
  // "UMD minimale": lo stesso file funziona nel browser (variabile globale
  // FabricCalc) e in Node (module.exports), così i test Python eseguono
  // esattamente il codice che gira sull'iPhone.
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.FabricCalc = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Costanti
  // ---------------------------------------------------------------------------

  // Fattore di forma k della sezione del filo, definito da: A_filo = k · w · t
  //   rettangolo k = 1, ellisse k = π/4, lente (due archi parabolici) k = 2/3.
  // A parità di area e larghezza, la forma cambia lo SPESSORE, non la larghezza.
  const SHAPE_FACTORS = Object.freeze({
    rect: 1,
    ellipse: Math.PI / 4,
    lens: 2 / 3,
  });

  // Impaccamento esagonale compatto di cilindri uguali: π/(2√3) ≈ 0,9069.
  // Limite geometrico, usato solo per validare (i tow reali stanno molto sotto).
  const VF_MAX_HEX = Math.PI / (2 * Math.sqrt(3));

  // ---------------------------------------------------------------------------
  // Armature
  // ---------------------------------------------------------------------------
  // Ogni armatura è definita da una funzione che costruisce la matrice di un
  // rapporto (il più piccolo blocco che, ripetuto, dà tutto il tessuto).
  // Tutte le metriche (flottazioni, legature, ...) si ricavano DALLA MATRICE,
  // non da tabelle scritte a mano: aggiungere un'armatura = aggiungere una voce.

  function plainMatrix() {
    // Tela: ogni filo cambia lato a ogni incrocio → scacchiera 2×2.
    return [[1, 0], [0, 1]];
  }

  function twillMatrix(up, down) {
    // Saia up/down: l'ordito sta sopra per `up` trame consecutive e sotto per
    // `down`; ogni filo successivo è spostato di una trama → la diagonale.
    // (j − i) mod R < up  ⇒  ordito sopra.
    const R = up + down;
    const M = [];
    for (let i = 0; i < R; i++) {
      const col = [];
      for (let j = 0; j < R; j++) col.push(((j - i) % R + R) % R < up ? 1 : 0);
      M.push(col);
    }
    return M;
  }

  function satinMatrix(offsets) {
    // Raso (satin) a effetto ordito: ogni filo di ordito passa SOTTO una sola
    // trama per rapporto, nella posizione offsets[i]; per il resto flotta sopra.
    // Per i satin "regolari" offsets[i] = (s · i) mod R, con s (lo "spostamento")
    // primo con R e diverso da 1 e R−1, altrimenti le legature si toccano in
    // diagonale e diventa una saia. Con R = 4 uno spostamento così non esiste:
    // il 4H (crowfoot) è per forza una saia 3/1 "spezzata", offsets [0,1,3,2].
    const R = offsets.length;
    const M = [];
    for (let i = 0; i < R; i++) {
      const col = [];
      for (let j = 0; j < R; j++) col.push(j === offsets[i] ? 0 : 1);
      M.push(col);
    }
    return M;
  }

  function regularSatinOffsets(R, s) {
    const out = [];
    for (let i = 0; i < R; i++) out.push((s * i) % R);
    return out;
  }

  // Ordine = ordine di visualizzazione nell'app. label: nome esteso; short:
  // nome breve per i pulsanti. I nomi inglesi sono quelli usati in reparto
  // e nelle schede tecniche dei tessuti.
  const WEAVES = Object.freeze({
    plain:   { label: "Plain (tela)",       short: "Plain",     build: plainMatrix },
    twill22: { label: "Twill 2×2 (saia)",   short: "Twill 2×2", build: () => twillMatrix(2, 2) },
    twill44: { label: "Twill 4×4 (saia)",   short: "Twill 4×4", build: () => twillMatrix(4, 4) },
    satin4:  { label: "Satin 4H crowfoot",  short: "4H",        build: () => satinMatrix([0, 1, 3, 2]) },
    satin5:  { label: "Satin 5H",           short: "5H",        build: () => satinMatrix(regularSatinOffsets(5, 2)) },
    satin8:  { label: "Satin 8H",           short: "8H",        build: () => satinMatrix(regularSatinOffsets(8, 3)) },
  });
  const WEAVE_ORDER = Object.freeze(Object.keys(WEAVES));

  function weaveMatrix(id) {
    // Matrice nuova a ogni chiamata: chi la riceve può modificarla senza
    // corrompere quella di qualcun altro.
    return WEAVES[id] ? WEAVES[id].build() : null;
  }

  function cyclicRuns(seq) {
    // Analizza una sequenza CICLICA di 0/1 (il rapporto si ripete):
    //   transitions = quante volte il filo cambia lato in un rapporto;
    //   max_run     = la flottazione più lunga (sopra o sotto), in incroci.
    // Ciclica perché l'ultimo incrocio del rapporto confina con il primo di
    // quello successivo: una flottazione può "scavalcare" il bordo.
    const n = seq.length;
    let transitions = 0;
    for (let k = 0; k < n; k++) if (seq[k] !== seq[(k + 1) % n]) transitions++;
    if (transitions === 0) return { transitions: 0, max_run: Infinity }; // filo mai legato
    // Partiamo da un punto di cambio: così nessuna flottazione viene spezzata in due.
    let start = 0;
    while (seq[start] === seq[(start + n - 1) % n]) start++;
    let maxRun = 0;
    let run = 0;
    for (let k = 0; k < n; k++) {
      const a = seq[(start + k) % n];
      const prev = seq[(start + k - 1 + n) % n];
      run = k === 0 || a !== prev ? 1 : run + 1;
      if (run > maxRun) maxRun = run;
    }
    return { transitions: transitions, max_run: maxRun };
  }

  function weaveStats(M) {
    // Metriche adimensionali di un'armatura, ricavate dalla sola matrice.
    const Rw = M.length;     // fili di ordito nel rapporto
    const Rp = M[0].length;  // fili di trama nel rapporto
    let tWarp = 0, tWeft = 0, fWarp = 0, fWeft = 0, ones = 0;

    for (let i = 0; i < Rw; i++) {
      const r = cyclicRuns(M[i]); // lungo l'ordito i si incontrano le trame j
      tWarp += r.transitions;
      fWarp = Math.max(fWarp, r.max_run);
      for (let j = 0; j < Rp; j++) ones += M[i][j];
    }
    for (let j = 0; j < Rp; j++) {
      const seq = [];
      for (let i = 0; i < Rw; i++) seq.push(1 - M[i][j]); // 1 = trama sopra
      const r = cyclicRuns(seq);
      tWeft += r.transitions;
      fWeft = Math.max(fWeft, r.max_run);
    }
    const cells = Rw * Rp;
    return {
      repeat_warp: Rw,
      repeat_weft: Rp,
      // Indice di intreccio = cambi di lato per incrocio attraversato.
      // Tela 1; saia 2/2 e crowfoot 0,5; 5H 0,4; saia 4/4 e 8H 0,25.
      // È il numero che governa crimp e stabilità: più è alto, più il filo
      // ondula (crimp) e più il tessuto resiste alla distorsione.
      interlacing_warp: tWarp / cells,
      interlacing_weft: tWeft / cells,
      float_max_warp: fWarp, // flottazione più lunga dell'ordito, in trame
      float_max_weft: fWeft, // flottazione più lunga della trama, in orditi
      // Legature per rapporto: ogni "passaggio sotto e ritorno" dell'ordito
      // conta 2 cambi di lato → legature = cambi / 2.
      bindings_per_repeat: tWarp / 2,
      // Frazione del diritto coperta dall'ordito (vista dall'alto):
      // 0,5 in tela e saie bilanciate, (R−1)/R nei satin a effetto ordito.
      warp_face: ones / cells,
    };
  }

  // ---------------------------------------------------------------------------
  // Relazioni elementari (ognuna = una relazione fisica)
  // ---------------------------------------------------------------------------

  function fiberArea(tex, rho) {
    // Area di SOLA fibra nella sezione del filo [mm²].
    //   1 mm² × 1 km = 1e-6 m² × 1e3 m = 1e-3 m³ = 1000 cm³
    //   ⇒ massa di 1 km = A[mm²] · 1000 · ρ   ⇒   A = tex / (1000 · ρ)
    return tex / (1000 * rho);
  }

  function texFromGeometry(filaments, diameterUm, rho) {
    // Caso generale: tex = 10⁻³ · ρ · Σ A_i  [A in µm²]; qui il caso
    // particolare di N filamenti circolari uguali: Σ A_i = N · π d² / 4.
    // Serve solo a controllare la coerenza dei dati di scheda tecnica.
    const dMm = diameterUm / 1000;
    const area = (filaments * Math.PI * dMm * dMm) / 4; // mm²
    return area * 1000 * rho;
  }

  function equivalentDiameterUm(tex, filaments, rho) {
    // Inversa della precedente: il diametro che rende coerenti tex, N e ρ.
    // In scheda d è spesso arrotondato (5 o 7 µm); tex e ρ sono misurati meglio.
    const areaPerFilament = fiberArea(tex, rho) / filaments; // mm²
    return Math.sqrt((4 * areaPerFilament) / Math.PI) * 1000; // µm
  }

  function nativeWidth(tex, rho, phi, shapeK, tNative) {
    // Larghezza del tow SENZA spreading, stimata dalla sua sezione:
    //   caso generale   A_tow = k · w · t      (k = fattore di forma)
    //   con             A_tow = A_f / φ         (φ = impacchettamento dei filamenti)
    //   ⇒               w₀ = A_f / (φ · k · t₀)
    // Attenzione: w₀ dipende dal PRODOTTO φ·t₀. Un errore del 10 % su uno dei
    // due è un errore del 10 % sulla larghezza, e quindi sui gap.
    return fiberArea(tex, rho) / (phi * shapeK * tNative);
  }

  function fawFromN(n, tex, crimp) {
    // Grammatura portata da UNA direzione con n fili/cm, su 1 m² di tessuto:
    //   100·n fili per metro di larghezza, ognuno lungo (1 + c) m per il crimp,
    //   ogni metro di filo pesa T/1000 g  ⇒  FAW_dir = n · T · (1 + c) / 10
    return (n * tex * (1 + crimp)) / 10;
  }

  function nFromFaw(fawDir, tex, crimp) {
    // Inversa: n = 10 · FAW_dir / (T · (1 + c))
    return (10 * fawDir) / (tex * (1 + crimp));
  }

  function pitchMm(n) {
    // Passo tra fili adiacenti [mm] = 10 mm / (fili/cm). null se la direzione
    // non esiste: null (e non Infinity) viaggia uguale in JSON e in Python.
    return n > 0 ? 10 / n : null;
  }

  function impliedCrimp(fawMeas, nWarp, texWarp, nWeft, texWeft) {
    // Dalla grammatura MISURATA di un tessuto con fili/cm noti si ricava il
    // crimp medio (ipotesi: uguale nelle due direzioni):
    //   FAW = (n_o·T_o + n_t·T_t)(1 + c) / 10  ⇒  c = 10·FAW/(n_o·T_o + n_t·T_t) − 1
    // È il modo più economico per tarare il modello su un tessuto reale.
    const base = nWarp * texWarp + nWeft * texWeft;
    return base > 0 ? (10 * fawMeas) / base - 1 : null;
  }

  function yarnGeometry(tex, rho, n, vfYarn, shapeK, wMeas, tNative) {
    // Geometria di UN sistema di fili (ordito oppure trama).
    if (!(n > 0)) return null; // direzione assente (es. quota 100 % in ordito)

    const af = fiberArea(tex, rho); // mm², sola fibra
    const ay = af / vfYarn;         // mm², tow con i vuoti tra i filamenti (vfYarn = φ)
    const p = pitchMm(n);           // mm

    // Larghezza RICHIESTA per copertura piena: w = p. Dall'area: t = A_tow/(k·p).
    // È anche lo spessore del tow DOPO uno spreading che chiude i gap
    // (a parità di φ): serve a capire quanto sottile deve diventare.
    const tReq = ay / (shapeK * p);

    const g = {
      af: af,
      ay: ay,
      pitch: p,
      per_inch: n * 2.54, // molti tessitori specificano in fili/pollice
      w_req: p,
      t_req: tReq,
      ar_req: p / tReq,
      w_tow: null,        // larghezza del tow senza spreading
      w_source: null,     // "measured" | "estimated" | null
      cover: null,
      gap: null,
      t_tow: null,
      ar_tow: null,
      spread_factor: null,
    };

    // Da dove viene la larghezza nativa: una misura vince sempre sulla stima.
    let wTow = null;
    if (wMeas > 0) {
      wTow = wMeas;
      g.w_source = "measured";
    } else if (tNative > 0) {
      wTow = ay / (shapeK * tNative); // = nativeWidth(tex, rho, vfYarn, shapeK, tNative)
      g.w_source = "estimated";
    }

    if (wTow !== null) {
      g.w_tow = wTow;
      g.cover = wTow / p;              // copertura lineare; > 1 = sovrapposizione
      g.gap = p - wTow;                // mm; negativo = sovrapposizione
      g.t_tow = ay / (shapeK * wTow);  // spessore del tow nativo
      g.ar_tow = wTow / g.t_tow;
      // Di quante volte va allargato il tow per chiudere il gap: s = p / w₀.
      // Nota: s = t₀ / t_req, rapporto tra spessore nativo e spessore richiesto.
      g.spread_factor = p / wTow;
    }
    return g;
  }

  function fabricCover(cWarp, cWeft) {
    // Copertura AREALE (Peirce): l'area scoperta è il prodotto delle frazioni
    // scoperte nelle due direzioni ⇒ C = c_o + c_t − c_o · c_t (limitate a 1).
    const a = Math.min(cWarp, 1);
    const b = Math.min(cWeft, 1);
    return a + b - a * b;
  }

  // ---------------------------------------------------------------------------
  // Validazione: meglio un messaggio chiaro che un numero assurdo.
  // ---------------------------------------------------------------------------

  function isPos(x) {
    return typeof x === "number" && isFinite(x) && x > 0;
  }

  function isNonNeg(x) {
    return typeof x === "number" && isFinite(x) && x >= 0;
  }

  function validate(inp) {
    if (!WEAVES[inp.weave]) return "Armatura non riconosciuta.";
    if (!SHAPE_FACTORS[inp.shape]) return "Forma della sezione non riconosciuta.";
    const yarns = [["ordito", inp.warp], ["trama", inp.weft]];
    for (const [label, y] of yarns) {
      if (!y || !isPos(y.tex)) return "Titolo (tex) del filo di " + label + " mancante.";
      if (!isPos(y.rho)) return "Densità della fibra di " + label + " mancante.";
    }
    if (!isPos(inp.vf_yarn) || inp.vf_yarn > VF_MAX_HEX) {
      return "Il fattore di impacchettamento φ deve stare tra 0 e 90,7 % (limite dell'impaccamento esagonale).";
    }
    if (!isPos(inp.vf_lam) || inp.vf_lam > VF_MAX_HEX) {
      return "Il Vf del laminato deve stare tra 0 e 0,907.";
    }
    if (!isNonNeg(inp.crimp_warp) || !isNonNeg(inp.crimp_weft)) {
      return "Il crimp non può essere negativo.";
    }
    if (!isNonNeg(inp.tex_tol) || inp.tex_tol >= 1) {
      return "La tolleranza sul tex deve stare tra 0 e 100 %.";
    }
    if (inp.mode === "faw") {
      if (!isPos(inp.faw_target)) return "Inserisci una grammatura obiettivo maggiore di zero.";
      if (!isNonNeg(inp.warp_share) || inp.warp_share > 1) {
        return "La quota in ordito deve stare tra 0 e 100 %.";
      }
    } else if (inp.mode === "density") {
      if (!isNonNeg(inp.n_warp) || !isNonNeg(inp.n_weft)) {
        return "Le densità (fili/cm) non possono essere negative.";
      }
      if (inp.n_warp + inp.n_weft === 0) return "Inserisci almeno una densità maggiore di zero.";
    } else {
      return "Modalità di calcolo non riconosciuta.";
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Metriche che dipendono dall'armatura E dai fili/cm
  // ---------------------------------------------------------------------------

  function addWeaveGeometry(warp, weft, st) {
    // Le flottazioni si misurano in fili ATTRAVERSATI: l'ordito flotta sopra
    // le trame, quindi la sua lunghezza in mm usa il passo della trama.
    if (warp && weft) {
      warp.float_max_mm = st.float_max_warp * weft.pitch;
      weft.float_max_mm = st.float_max_weft * warp.pitch;
      // Rapporto in mm: lungo l'ordito si susseguono Rp trame, e viceversa.
      warp.repeat_mm = st.repeat_weft * weft.pitch;
      weft.repeat_mm = st.repeat_warp * warp.pitch;
      // Cambi di lato per cm di filo = indice × incroci per cm.
      warp.transitions_cm = st.interlacing_warp * (10 / weft.pitch);
      weft.transitions_cm = st.interlacing_weft * (10 / warp.pitch);
    }
    [warp, weft].forEach((g) => {
      // Con una sola direzione (tessuto "tutto ordito") le metriche d'intreccio
      // non esistono: le mettiamo a null per avere sempre le stesse chiavi.
      if (g && g.float_max_mm === undefined) {
        g.float_max_mm = null;
        g.repeat_mm = null;
        g.transitions_cm = null;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Punto d'ingresso unico: un oggetto di ingressi → un oggetto di risultati.
  // ---------------------------------------------------------------------------

  function compute(inp) {
    const err = validate(inp);
    if (err) return { error: err };

    const k = SHAPE_FACTORS[inp.shape];
    let nWarp, nWeft, fawWarp, fawWeft;

    if (inp.mode === "faw") {
      // Caso generale: la grammatura si divide secondo la quota IN MASSA φ
      // assegnata all'ordito. Bilanciato ⇔ φ = 0,5. Con filati diversi in
      // ordito e trama, "bilanciato in massa" NON significa "stessi fili/cm".
      fawWarp = inp.faw_target * inp.warp_share;
      fawWeft = inp.faw_target * (1 - inp.warp_share);
      nWarp = nFromFaw(fawWarp, inp.warp.tex, inp.crimp_warp);
      nWeft = nFromFaw(fawWeft, inp.weft.tex, inp.crimp_weft);
    } else {
      // Calcolo inverso: densità note (es. un tessuto esistente) → grammatura.
      nWarp = inp.n_warp;
      nWeft = inp.n_weft;
      fawWarp = fawFromN(nWarp, inp.warp.tex, inp.crimp_warp);
      fawWeft = fawFromN(nWeft, inp.weft.tex, inp.crimp_weft);
    }

    const faw = fawWarp + fawWeft;
    const warp = yarnGeometry(inp.warp.tex, inp.warp.rho, nWarp, inp.vf_yarn, k, inp.w_meas_warp, inp.t_native_warp);
    const weft = yarnGeometry(inp.weft.tex, inp.weft.rho, nWeft, inp.vf_yarn, k, inp.w_meas_weft, inp.t_native_weft);

    const st = weaveStats(weaveMatrix(inp.weave));
    addWeaveGeometry(warp, weft, st);

    let coverFabric = null;
    let openArea = null, holesCm2 = null, holeW = null, holeH = null;
    if (warp && weft && warp.cover !== null && weft.cover !== null) {
      coverFabric = fabricCover(warp.cover, weft.cover);
      // Buchi PASSANTI: esistono solo dove un gap tra orditi incrocia un gap
      // tra trame. Altrove il gap di una direzione è coperto dai fili
      // dell'altra (resta però un canale ricco di resina a metà spessore).
      //   un buco per cella del reticolo ⇒ n_o · n_t buchi/cm²
      //   dimensione g_o × g_t; area aperta = (g_o/p_o)(g_t/p_t) = (1 − c_o)(1 − c_t)
      // Vale per ogni armatura: in pianta la posizione dei fili non dipende
      // da chi sta sopra (lo spostamento reale dei fili non è modellato).
      holeW = Math.max(warp.gap, 0); // tra due orditi, misurato lungo la trama
      holeH = Math.max(weft.gap, 0); // tra due trame, misurato lungo l'ordito
      openArea = (holeW / warp.pitch) * (holeH / weft.pitch);
      holesCm2 = holeW > 0 && holeH > 0 ? nWarp * nWeft : 0;
    }

    // Spessore del ply curato: volume di fibra per m² diviso per il Vf.
    //   FAW/ρ [cm³/m²] = 10⁻³ mm di fibra "solida"  ⇒  t = Σ(FAW_k/ρ_k)/(1000·Vf)
    // Somma per direzione perché ordito e trama possono avere densità diverse.
    const plyThickness = (fawWarp / inp.warp.rho + fawWeft / inp.weft.rho) / (1000 * inp.vf_lam);

    // Legature per cm² = legature per rapporto / incroci per rapporto × incroci per cm².
    const bindingsCm2 = nWarp > 0 && nWeft > 0
      ? (st.bindings_per_repeat / (st.repeat_warp * st.repeat_weft)) * nWarp * nWeft
      : null;

    // Crimp implicito: solo nel calcolo inverso e solo se è data una grammatura misurata.
    let crimpImplied = null;
    if (inp.mode === "density" && isPos(inp.faw_meas)) {
      crimpImplied = impliedCrimp(inp.faw_meas, nWarp, inp.warp.tex, nWeft, inp.weft.tex);
    }

    return {
      error: null,
      n_warp: nWarp,
      n_weft: nWeft,
      faw: faw,
      faw_warp: fawWarp,
      faw_weft: fawWeft,
      // Il tex entra linearmente nella grammatura: un errore relativo sul tex
      // si trasferisce 1:1 sulla FAW. Stima al primo ordine, non una garanzia.
      faw_min: faw * (1 - inp.tex_tol),
      faw_max: faw * (1 + inp.tex_tol),
      shape_k: k,
      warp: warp,
      weft: weft,
      cover_fabric: coverFabric,
      open_area: openArea,     // frazione di superficie passante (0–1)
      holes_cm2: holesCm2,     // buchi passanti per cm²
      hole_w: holeW,           // mm, lato del buco lungo la trama
      hole_h: holeH,           // mm, lato del buco lungo l'ordito
      weave: Object.assign({ id: inp.weave }, st),
      bindings_cm2: bindingsCm2,
      ply_thickness: plyThickness,
      ends_per_m: nWarp * 100,   // fili di ordito su 1 m di altezza (creel/orditura)
      picks_per_m: nWeft * 100,  // inserzioni di trama per metro (tempo telaio)
      crimp_implied: crimpImplied,
    };
  }

  return {
    SHAPE_FACTORS: SHAPE_FACTORS,
    VF_MAX_HEX: VF_MAX_HEX,
    WEAVES: WEAVES,
    WEAVE_ORDER: WEAVE_ORDER,
    weaveMatrix: weaveMatrix,
    weaveStats: weaveStats,
    cyclicRuns: cyclicRuns,
    fiberArea: fiberArea,
    texFromGeometry: texFromGeometry,
    equivalentDiameterUm: equivalentDiameterUm,
    nativeWidth: nativeWidth,
    fawFromN: fawFromN,
    nFromFaw: nFromFaw,
    pitchMm: pitchMm,
    impliedCrimp: impliedCrimp,
    yarnGeometry: yarnGeometry,
    fabricCover: fabricCover,
    validate: validate,
    compute: compute,
  };
});
