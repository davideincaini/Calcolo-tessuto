/* =============================================================================
 * app.js — interfaccia di Trama (v2)
 * -----------------------------------------------------------------------------
 * Questo file NON contiene formule: legge i campi, chiama FabricCalc.compute()
 * (definito in calc.js) e disegna i risultati. Tenere separati "cosa si
 * calcola" e "come si mostra" permette di testare i calcoli senza browser.
 *
 * Flusso a ogni modifica di un campo:
 *   evento → aggiorna `state` → salva → buildCalcInput(state)
 *   → FabricCalc.compute() → render*()
 *
 * Tre viste (Calcolo, Confronto, Filati) in un'unica pagina: niente router,
 * niente librerie. L'app deve funzionare offline sull'iPhone e ogni
 * dipendenza in più è una cosa che può rompersi o non caricarsi.
 * ===========================================================================*/

(function () {
  "use strict";

  const Calc = window.FabricCalc;
  const $ = (id) => document.getElementById(id);

  // Chiavi di localStorage con versione. Lo STATO usa "v2" perché ha una
  // struttura diversa da Trama v1 (armatura, confronto): se entrambe le app
  // vivono sullo stesso dominio github.io non si pestano i piedi.
  // I FILATI PERSONALI invece restano su "v1": stesso formato, così quelli
  // inseriti con Trama v1 compaiono anche qui senza reinserirli.
  const KEY_STATE = "trama.state.v2";
  const KEY_CUSTOM = "trama.customFibers.v1";

  const MAX_SLOTS = 4;       // oltre 4 disegni affiancati, su iPhone non si legge più nulla
  const MIN_SLOTS = 2;       // un confronto ha senso da due in su
  const MAX_YARNS_VIEW = 40; // fili per direzione in un disegno: limite per la fluidità

  // Colori del disegno. Ripetono la palette di styles.css perché il disegno
  // viene anche ESPORTATO come immagine, e lì il foglio di stile non arriva:
  // ogni colore deve stare scritto dentro l'SVG.
  const COLORS = {
    resin: "#F3DFB6",
    warp: "#2E3338",
    weft: "#6A737C",
    towLine: "rgba(255,255,255,0.16)",
    edge: "rgba(0,0,0,0.35)",
    scaleBg: "rgba(255,255,255,0.92)",
    ink: "#1C2024",
    ink2: "#5B636B",
    line: "#DDE1E4",
    chipOn: "#2E3338",
    chipOff: "#DCE0E3",
  };

  const FONT = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";

  // ---------------------------------------------------------------------------
  // Stato
  // ---------------------------------------------------------------------------

  // Salviamo le STRINGHE dei campi, non i numeri: "0,70" resta scritto come
  // l'ha scritto l'utente e un campo vuoto resta vuoto.
  const DEFAULTS = {
    view: "calc",
    warpId: "Toray|T300|3000",
    weftId: "Toray|T300|3000",
    weftDifferent: false,
    weave: "satin5",
    mode: "faw",
    faw: "280",
    share: "50",
    nWarp: "7",
    nWeft: "7",
    fawMeas: "",
    crimpWarp: "1",
    crimpWeft: "1",
    texTol: "3",
    vf: "0,70",
    shape: "rect",
    vfLam: "0,55",
    wWarp: "",
    wWeft: "",
    // Confronto predefinito: lo stesso della discussione da cui nasce l'app,
    // un 6K standard e un 6K a filamento fine, entrambi in 5H.
    slots: [
      { fiberId: "Toray|T300|6000", weave: "satin5", wMeas: "" },
      { fiberId: "Toray|T800H|6000", weave: "satin5", wMeas: "" },
    ],
    dbQuery: "",
  };

  let state = loadState();
  let dbMeta = { disclaimer: "", updated: "" };
  let seedFibers = [];   // da fibers.json (sola lettura)
  let customFibers = []; // aggiunte dall'utente, salvate sul telefono
  let allFibers = [];    // unione delle due liste, con un id per ciascuna
  let lastResult = null; // ultimo risultato valido del Calcolo
  let lastInput = null;  // ultimi ingressi del Calcolo (base del confronto)

  function loadState() {
    // Uniamo i valori salvati ai predefiniti: se in un aggiornamento
    // aggiungiamo un campo, chi ha già l'app non si ritrova "undefined".
    const saved = loadJSON(KEY_STATE, {});
    const s = Object.assign({}, DEFAULTS, saved);
    const okSlots = Array.isArray(s.slots) && s.slots.length >= MIN_SLOTS &&
      s.slots.every((x) => x && typeof x.fiberId === "string" && Calc.WEAVES[x.weave]);
    if (!okSlots) s.slots = DEFAULTS.slots.map((x) => Object.assign({}, x));
    if (!Calc.WEAVES[s.weave]) s.weave = DEFAULTS.weave;
    return s;
  }

  // ---------------------------------------------------------------------------
  // Utilità
  // ---------------------------------------------------------------------------

  function loadJSON(key, fallback) {
    // try/catch: localStorage può essere disattivato o pieno. In quel caso
    // l'app funziona lo stesso, solo senza memoria.
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* vedi loadJSON: fallire in silenzio qui è voluto */
    }
  }

  function parseNum(str) {
    // La tastiera decimale di iOS in italiano scrive la virgola: la accettiamo
    // insieme al punto. Stringa vuota → NaN, che la validazione intercetta.
    if (str === null || str === undefined) return NaN;
    const s = String(str).trim().replace(",", ".");
    return s === "" ? NaN : Number(s);
  }

  function optionalNum(str) {
    // Campi facoltativi: vuoto o non numerico → null ("non fornito").
    const x = parseNum(str);
    return isFinite(x) && x > 0 ? x : null;
  }

  // Un formattatore per numero di decimali, creato una volta sola:
  // Intl.NumberFormat è costoso da costruire e qui ridisegniamo spesso.
  const formatters = {};
  function fmt(x, digits) {
    if (x === null || x === undefined || !isFinite(x)) return "—";
    if (!formatters[digits]) {
      formatters[digits] = new Intl.NumberFormat("it-IT", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    }
    return formatters[digits].format(x);
  }

  function fmtInput(x, digits) {
    // Per riscrivere un numero dentro un campo: senza separatore delle
    // migliaia (il punto verrebbe riletto come decimale).
    return fmt(x, digits).replace(/\./g, "");
  }

  function escapeHTML(s) {
    // I dati importati da file sono input non fidato: mai inserirli come HTML
    // senza "disinnescare" < > & " '.
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function kLabel(filaments) {
    // 3000 → "3K", 1500 → "1,5K"; conteggi strani restano numeri.
    if (filaments % 1000 === 0) return filaments / 1000 + "K";
    if (filaments % 500 === 0) return fmt(filaments / 1000, 1) + "K";
    return String(filaments);
  }

  function fiberId(f) {
    return [f.supplier, f.grade, f.filaments].join("|");
  }

  function fiberName(f) {
    return f.grade + " " + kLabel(f.filaments);
  }

  function findFiber(id) {
    return allFibers.find((f) => f.id === id) || null;
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------------------
  // Database
  // ---------------------------------------------------------------------------

  async function loadDatabase() {
    try {
      // Il service worker risponde dalla rete se c'è, altrimenti dalla cache:
      // un database aggiornato su GitHub arriva al primo avvio online.
      const res = await fetch("fibers.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const db = await res.json();
      dbMeta = { disclaimer: db.disclaimer || "", updated: db.updated || "" };
      seedFibers = Array.isArray(db.fibers) ? db.fibers : [];
    } catch (e) {
      seedFibers = [];
      showError("Database non disponibile. Apri l'app almeno una volta con la connessione attiva.");
    }
    customFibers = loadJSON(KEY_CUSTOM, []);
    mergeFibers();
  }

  function mergeFibers() {
    // I filati personali hanno un id con prefisso "custom|": non possono
    // sovrascrivere per errore un record del database ufficiale.
    allFibers = seedFibers
      .map((f) => Object.assign({}, f, { id: fiberId(f), custom: false }))
      .concat(customFibers.map((f) => Object.assign({}, f, { id: "custom|" + fiberId(f), custom: true })));
  }

  function suppliers() {
    // localeCompare("it") ordina come un italiano si aspetta.
    return Array.from(new Set(allFibers.map((f) => f.supplier))).sort((a, b) => a.localeCompare(b, "it"));
  }

  function fibersOf(supplier) {
    return allFibers
      .filter((f) => f.supplier === supplier)
      .sort((a, b) => a.grade.localeCompare(b.grade, "it", { numeric: true }) || a.filaments - b.filaments);
  }

  function fillSupplierSelect(select, current) {
    select.innerHTML = suppliers()
      .map((s) => `<option value="${escapeHTML(s)}"${s === current ? " selected" : ""}>${escapeHTML(s)}</option>`)
      .join("");
  }

  function fillFiberSelect(select, supplier, currentId) {
    const list = fibersOf(supplier);
    select.innerHTML = list
      .map((f) => {
        const label = fiberName(f) + ", " + fmt(f.tex, 0) + " tex" + (f.custom ? " (tuo)" : "");
        return `<option value="${escapeHTML(f.id)}"${f.id === currentId ? " selected" : ""}>${escapeHTML(label)}</option>`;
      })
      .join("");
    // Se l'id salvato non esiste più (filato rimosso), prendiamo il primo.
    return list.some((f) => f.id === currentId) ? currentId : list.length ? list[0].id : null;
  }

  function fiberMeta(f) {
    // Riassunto di un filato in una riga. Il diametro equivalente dice quanto
    // dovrebbe valere d per essere coerente con tex e densità: se differisce
    // molto da quello in scheda, di solito è la scheda ad arrotondare.
    const dEq = Calc.equivalentDiameterUm(f.tex, f.filaments, f.density);
    const d = f.filament_diameter_um;
    const parts = [
      fmt(f.tex, 0) + " tex",
      "ρ " + fmt(f.density, 2) + " g/cm³",
      "d " + (d ? fmt(d, 1) + " µm" : "n.d.") + " (da tex " + fmt(dEq, 2) + ")",
    ];
    if (f.tensile_modulus_gpa) parts.push("E " + fmt(f.tensile_modulus_gpa, 0) + " GPa");
    return parts.join(", ");
  }

  function renderFiberInfo(elm, f) {
    if (!f) {
      elm.textContent = "";
      return;
    }
    const badge = f.custom
      ? '<span class="badge mine">tuo</span>'
      : f.verified ? '<span class="badge ok">verificato</span>' : '<span class="badge">da verificare</span>';
    const source = f.source ? "<br>Fonte: " + escapeHTML(f.source) : "";
    const notes = f.notes ? "<br>" + escapeHTML(f.notes) : "";
    elm.innerHTML = escapeHTML(fiberMeta(f)) + " " + badge + source + notes;
  }

  // ---------------------------------------------------------------------------
  // Dallo stato agli ingressi del calcolo
  // ---------------------------------------------------------------------------

  function buildCalcInput(s) {
    const warpF = findFiber(s.warpId);
    const weftF = s.weftDifferent ? findFiber(s.weftId) : warpF;
    return {
      mode: s.mode,
      faw_target: parseNum(s.faw),
      warp_share: parseNum(s.share) / 100, // l'utente scrive %, il motore vuole frazioni
      n_warp: parseNum(s.nWarp),
      n_weft: parseNum(s.nWeft),
      faw_meas: optionalNum(s.fawMeas),
      warp: warpF ? { tex: warpF.tex, rho: warpF.density } : null,
      weft: weftF ? { tex: weftF.tex, rho: weftF.density } : null,
      crimp_warp: parseNum(s.crimpWarp) / 100,
      crimp_weft: parseNum(s.crimpWeft) / 100,
      tex_tol: parseNum(s.texTol) / 100,
      vf_yarn: parseNum(s.vf),
      vf_lam: parseNum(s.vfLam),
      shape: s.shape,
      weave: s.weave,
      w_meas_warp: optionalNum(s.wWarp),
      w_meas_weft: optionalNum(s.wWeft),
    };
  }

  // ---------------------------------------------------------------------------
  // Disegno del tessuto (condiviso da Calcolo, Confronto ed export)
  // ---------------------------------------------------------------------------

  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(name, attrs) {
    // createElementNS è obbligatorio: con createElement il browser crea tag
    // HTML che dentro un <svg> non vengono disegnati.
    const node = document.createElementNS(SVG_NS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function niceScale(target) {
    // Lunghezza "tonda" per la barra di scala, vicina a target.
    const steps = [0.5, 1, 2, 5, 10, 20, 50];
    return steps.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), steps[0]);
  }

  function drawFabric(svg, o) {
    // Disegna in `svg` una finestra quadrata di tessuto di lato o.win mm.
    //   o.matrix  matrice dell'armatura (1 = ordito sopra)
    //   o.pw/pf   passo di ordito e trama [mm]
    //   o.ww/wf   larghezza disegnata dei fili [mm] (misurata o richiesta)
    //   o.uid     prefisso unico per gli id: più disegni stanno nella stessa
    //             pagina e un id duplicato farebbe usare il pattern sbagliato
    //   o.S       lato in unità SVG
    const S = o.S || 320;
    const s = S / o.win; // unità SVG per mm
    svg.setAttribute("viewBox", `0 0 ${S} ${S}`);
    svg.replaceChildren();

    // Pattern di "filamenti": righe chiare sottili lungo il filo, che rendono
    // leggibile la direzione. userSpaceOnUse: stessa densità di righe in tutti
    // i disegni, anche se hanno scale diverse.
    const defs = el("defs", {});
    const mkPattern = (id, vertical, fill) => {
      const p = el("pattern", { id: id, width: 4, height: 4, patternUnits: "userSpaceOnUse" });
      p.appendChild(el("rect", { width: 4, height: 4, fill: fill }));
      p.appendChild(el("line", vertical
        ? { x1: 2, y1: 0, x2: 2, y2: 4, stroke: COLORS.towLine, "stroke-width": 0.8 }
        : { x1: 0, y1: 2, x2: 4, y2: 2, stroke: COLORS.towLine, "stroke-width": 0.8 }));
      return p;
    };
    defs.appendChild(mkPattern(o.uid + "-o", true, COLORS.warp));
    defs.appendChild(mkPattern(o.uid + "-t", false, COLORS.weft));
    svg.appendChild(defs);
    const fillWarp = `url(#${o.uid}-o)`;
    const fillWeft = `url(#${o.uid}-t)`;

    // 1) Fondo ambra: si vede solo dove non c'è fibra.
    svg.appendChild(el("rect", { x: 0, y: 0, width: S, height: S, fill: COLORS.resin }));

    const M = o.matrix;
    const Rw = M.length;
    const Rp = M[0].length;
    const nx = Math.min(Math.ceil(o.win / o.pw) + 1, MAX_YARNS_VIEW + 2);
    const ny = Math.min(Math.ceil(o.win / o.pf) + 1, MAX_YARNS_VIEW + 2);
    const cx = (i) => (i + 0.5) * o.pw * s; // centro dell'ordito i
    const cy = (j) => (j + 0.5) * o.pf * s; // centro della trama j
    const hw = (o.ww * s) / 2;
    const hf = (o.wf * s) / 2;
    const edge = { stroke: COLORS.edge, "stroke-width": 0.6 };

    // 2) Trama sotto (righe intere), 3) ordito sopra (colonne intere)...
    for (let j = 0; j < ny; j++) {
      svg.appendChild(el("rect", Object.assign({ x: 0, y: cy(j) - hf, width: S, height: 2 * hf, fill: fillWeft }, edge)));
    }
    for (let i = 0; i < nx; i++) {
      svg.appendChild(el("rect", Object.assign({ x: cx(i) - hw, y: 0, width: 2 * hw, height: S, fill: fillWarp }, edge)));
    }
    // 4) ...poi, dove la matrice dice "trama sopra", ridisegniamo un tratto di
    //    trama SOPRA l'ordito. È l'armatura: stesso codice per tela, saie e satin.
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (M[i % Rw][j % Rp] === 0) {
          svg.appendChild(el("rect", Object.assign({ x: cx(i) - hw, y: cy(j) - hf, width: 2 * hw, height: 2 * hf, fill: fillWeft }, edge)));
        }
      }
    }

    // 5) Barra di scala in mm, su fondo bianco per restare leggibile.
    const L = niceScale(o.win / 4);
    const barPx = L * s;
    // La barra cresce con il disegno (utile nell'export) e con o.barK, che serve
    // nei disegni del confronto: a metà larghezza dello schermo, 11 px diventerebbero ~6.
    const k = (S / 320) * (o.barK || 1);
    const g = el("g", { transform: `translate(${10 * k} ${S - 34 * k}) scale(${k})` });
    g.appendChild(el("rect", { x: 0, y: 0, width: barPx / k + 20, height: 26, rx: 6, fill: COLORS.scaleBg }));
    g.appendChild(el("rect", { x: 10, y: 17, width: barPx / k, height: 3, fill: COLORS.ink }));
    const label = el("text", { x: 10, y: 13, fill: COLORS.ink, "font-size": 11, "font-weight": 600, "font-family": FONT });
    label.textContent = fmt(L, L < 1 ? 1 : 0) + " mm";
    g.appendChild(label);
    svg.appendChild(g);
  }

  function drawnWidths(res) {
    // Larghezza da disegnare: misurata se c'è, altrimenti quella richiesta
    // (che per costruzione dà copertura piena, senza gap).
    return {
      ww: res.warp.w_meas !== null ? res.warp.w_meas : res.warp.w_req,
      wf: res.weft.w_meas !== null ? res.weft.w_meas : res.weft.w_req,
    };
  }

  function viewWindow(results, repeats) {
    // Lato della finestra in mm, comune a tutti i risultati passati:
    //  - abbastanza grande da contenere `repeats` rapporti dell'armatura più ampia
    //    e almeno 6 passi del filo più rado;
    //  - non così grande da richiedere più di MAX_YARNS_VIEW fili per direzione
    //    al filo più fitto (il disegno diventerebbe lento e illeggibile).
    let rep = 0, pMax = 0, pMin = Infinity;
    results.forEach((r) => {
      rep = Math.max(rep, r.warp.repeat_mm, r.weft.repeat_mm);
      pMax = Math.max(pMax, r.warp.pitch, r.weft.pitch);
      pMin = Math.min(pMin, r.warp.pitch, r.weft.pitch);
    });
    const win = Math.max(repeats * rep, 6 * pMax);
    return Math.min(win, MAX_YARNS_VIEW * pMin);
  }

  function weaveChipSVG(id) {
    // "Carta tecnica" in miniatura: quadratino scuro = ordito sopra.
    // Mostriamo rapporti interi: 2 rapporti per quelli piccoli, 1 per 8×8.
    const M = Calc.weaveMatrix(id);
    const R = M.length;
    const N = R <= 5 ? 2 * R : R;
    let cells = "";
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const on = M[i % R][j % R] === 1;
        cells += `<rect x="${i + 0.06}" y="${j + 0.06}" width="0.88" height="0.88" fill="${on ? COLORS.chipOn : COLORS.chipOff}"/>`;
      }
    }
    return `<svg viewBox="0 0 ${N} ${N}" aria-hidden="true">${cells}</svg>`;
  }

  // ---------------------------------------------------------------------------
  // Vista Calcolo
  // ---------------------------------------------------------------------------

  function showError(msg) {
    const e = $("error");
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  function renderWeavePicker() {
    $("weave-picker").innerHTML = Calc.WEAVE_ORDER
      .map((id) =>
        `<button type="button" class="weave-chip" role="radio" data-weave="${id}" ` +
        `aria-checked="${id === state.weave}" aria-label="${escapeHTML(Calc.WEAVES[id].label)}">` +
        `${weaveChipSVG(id)}<span>${escapeHTML(Calc.WEAVES[id].short)}</span></button>`)
      .join("");
  }

  function weaveNote(id, st) {
    // Una frase pratica per armatura. Volutamente qualitativa: i numeri
    // stanno nella tabella, qui c'è cosa significano in reparto.
    const face = fmt(st.warp_face * 100, 0);
    const notes = {
      plain: "Il filo cambia lato a ogni incrocio: è l'armatura più stabile da maneggiare e, a parità di filato, quella con più crimp. Diritto e rovescio uguali.",
      twill22: "Metà dei cambi di lato della tela: drappeggia meglio e resta abbastanza stabile. Diritto e rovescio uguali.",
      twill44: "Stesso indice di intreccio dell'8H, ma diagonale regolare e diritto uguale al rovescio. Flottazioni su 4 fili: occhio alla distorsione in taglio e stesura.",
      satin4: "Il crowfoot è in realtà una saia 3/1 spezzata. Il diritto mostra il 75 % di ordito, il rovescio il 75 % di trama.",
      satin5: `Diritto quasi tutto ordito (${face} %), rovescio quasi tutto trama. Nel laminato di solito si specchiano i ply rispetto al piano medio, per non sbilanciarlo.`,
      satin8: `Diritto quasi tutto ordito (${face} %), rovescio quasi tutto trama. Flottazioni su 7 fili: drappeggia molto bene ma si distorce facilmente.`,
    };
    return notes[id] || "";
  }

  function renderKpis(res, inp) {
    if (res.error) {
      $("k-n").textContent = "—";
      $("k-faw").textContent = "—";
      $("k-w").textContent = "—";
      return;
    }
    $("k-n").textContent = fmt(res.n_warp, 2) + " × " + fmt(res.n_weft, 2);
    $("k-faw").textContent = fmt(res.faw, 1);
    $("k-faw-label").textContent =
      "Grammatura, g/m² (±" + fmt(inp.tex_tol * 100, 0) + " % tex: " +
      fmt(res.faw_min, 0) + "–" + fmt(res.faw_max, 0) + ")";
    const w1 = res.warp ? res.warp.w_req : null;
    const w2 = res.weft ? res.weft.w_req : null;
    // Bilanciato con lo stesso filato: un numero solo, stessa informazione.
    $("k-w").textContent =
      w1 !== null && w2 !== null && Math.abs(w1 - w2) < 1e-9 ? fmt(w1, 2) : fmt(w1, 2) + " / " + fmt(w2, 2);
  }

  function renderResultTable(res) {
    const body = $("result-table").querySelector("tbody");
    if (res.error) {
      body.innerHTML = "";
      $("width-note").innerHTML = "";
      return;
    }
    const o = res.warp || {};
    const t = res.weft || {};
    const st = res.weave;
    const row = (label, a, b, cls) =>
      `<tr${cls ? ` class="${cls}"` : ""}><th scope="row">${label}</th><td>${a}</td><td>${b}</td></tr>`;
    // Gap: ambra se resta spazio scoperto, rosso se i fili si sovrappongono.
    const gapCell = (g) =>
      g === null || g === undefined ? "—" : `<span class="${g < 0 ? "neg" : "gap"}">${fmt(g, 2)}</span>`;
    const floatCell = (mm, n) => (mm === null || mm === undefined ? "—" : `${fmt(mm, 1)} <span class="unit">(${n} fili)</span>`);

    let html = "";
    html += row("Fili/cm", fmt(res.warp ? res.n_warp : null, 2), fmt(res.weft ? res.n_weft : null, 2));
    html += row("Fili/pollice", fmt(o.per_inch, 1), fmt(t.per_inch, 1));
    html += row("Passo = larghezza richiesta, mm", fmt(o.w_req, 2), fmt(t.w_req, 2));
    html += row("Sezione di fibra del tow, mm²", fmt(o.af, 3), fmt(t.af, 3));
    html += row("Spessore a copertura piena, mm", fmt(o.t_req, 3), fmt(t.t_req, 3));
    html += row("Rapporto w/t richiesto", fmt(o.ar_req, 0), fmt(t.ar_req, 0));
    html += row("Flottazione più lunga, mm", floatCell(o.float_max_mm, st.float_max_warp), floatCell(t.float_max_mm, st.float_max_weft), "sep");
    html += row("Lunghezza del rapporto, mm", fmt(o.repeat_mm, 1), fmt(t.repeat_mm, 1));
    html += row("Cambi di lato per cm", fmt(o.transitions_cm, 1), fmt(t.transitions_cm, 1));

    const hasMeas = (o.w_meas || null) !== null || (t.w_meas || null) !== null;
    if (hasMeas) {
      html += row("Copertura lineare, %", fmt(o.cover * 100, 0), fmt(t.cover * 100, 0), "sep");
      html += row("Gap tra tow, mm", gapCell(o.gap), gapCell(t.gap));
      html += row("Allargamento per chiudere, ×", fmt(o.spread_factor, 2), fmt(t.spread_factor, 2));
    }
    body.innerHTML = html;
    $("width-note").innerHTML = widthNote(res, hasMeas);
  }

  function renderFacts(res, inp) {
    const dl = $("fabric-facts");
    if (res.error) {
      dl.innerHTML = "";
      return;
    }
    const st = res.weave;
    const facts = [
      ["Armatura", `${Calc.WEAVES[st.id].label}, rapporto ${st.repeat_warp}×${st.repeat_weft}`],
      ["Indice di intreccio (cambi di lato per incrocio)", fmt(st.interlacing_warp, 2)],
      ["Legature per cm²", fmt(res.bindings_cm2, 1)],
      ["Diritto coperto dall'ordito", fmt(st.warp_face * 100, 0) + " %"],
      [`Spessore del ply curato a Vf ${fmt(inp.vf_lam, 2)}`, fmt(res.ply_thickness, 3) + " mm"],
      ["Inserzioni di trama per metro", fmt(res.picks_per_m, 0)],
      ["Fili di ordito per metro di altezza", fmt(res.ends_per_m, 0)],
    ];
    if (res.cover_fabric !== null) facts.push(["Copertura areale stimata", fmt(res.cover_fabric * 100, 0) + " %"]);
    dl.innerHTML = facts.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join("");
  }

  function widthNote(res, hasMeas) {
    // Traduce i numeri in conseguenze pratiche, una frase per direzione.
    if (!hasMeas) {
      return "<p>Senza una larghezza misurata si sa solo quanto largo deve diventare il tow. " +
        "Misuralo nelle condizioni reali (dal rocchetto, dopo le guide, con la tensione di lavoro) " +
        "e inseriscilo in «Filo e laminato» per vedere gap o sovrapposizioni.</p>";
    }
    const parts = [];
    [["Ordito", res.warp], ["Trama", res.weft]].forEach(([name, g]) => {
      if (!g || g.w_meas === null) return;
      if (g.gap > 1e-9) {
        parts.push(
          `<p>${name}: restano ${fmt(g.gap, 2)} mm scoperti ogni ${fmt(g.pitch, 2)} mm ` +
          `(${fmt((g.gap / g.pitch) * 100, 0)} % della larghezza). Per chiudere serve allargare il tow di ` +
          `${fmt(g.spread_factor, 2)}× oppure passare a un titolo più fine.</p>`);
      } else if (g.gap < -1e-9) {
        parts.push(
          `<p>${name}: il tow è più largo del passo di ${fmt(-g.gap, 2)} mm. Nel tessuto verrà stretto ` +
          `verso ${fmt(g.pitch, 2)} mm, con spessore verso ${fmt(g.t_req, 3)} mm.</p>`);
      } else {
        parts.push(`<p>${name}: larghezza misurata e passo coincidono.</p>`);
      }
    });
    if (res.cover_fabric !== null) {
      parts.push(`<p>Copertura areale stimata ${fmt(res.cover_fabric * 100, 0)} %. ` +
        "Il resto è superficie senza fibra, che nel laminato diventa una zona ricca di resina.</p>");
    }
    return parts.join("");
  }

  function renderCrimpImplied(res, inp) {
    const p = $("crimp-implied");
    if (res.error || res.crimp_implied === null) {
      p.textContent = "Pesa un campione di area nota: con i fili/cm contati, l'app ricava il crimp reale.";
      p.classList.remove("gap");
      return;
    }
    const c = res.crimp_implied;
    if (c < 0) {
      p.textContent = `Crimp implicito ${fmt(c * 100, 2)} %: la grammatura misurata è più bassa di quella a crimp zero. ` +
        "Controlla tex, conteggio dei fili o area del campione.";
      p.classList.add("gap");
    } else {
      p.textContent = `Crimp medio implicito ${fmt(c * 100, 2)} %. Inseriscilo come crimp per allineare il modello a questo tessuto.`;
      p.classList.remove("gap");
    }
  }

  function drawCalc(res) {
    const svg = $("weave");
    if (!res || res.error || !res.warp || !res.weft) {
      svg.replaceChildren();
      const msg = el("text", { x: 160, y: 160, "text-anchor": "middle", fill: COLORS.ink2, "font-size": 14, "font-family": FONT });
      msg.textContent = res && !res.error ? "Anteprima disponibile con ordito e trama" : "Anteprima non disponibile";
      svg.setAttribute("viewBox", "0 0 320 320");
      svg.appendChild(msg);
      $("weave-caption").textContent = "";
      return;
    }
    const w = drawnWidths(res);
    const win = viewWindow([res], 2);
    drawFabric(svg, {
      matrix: Calc.weaveMatrix(res.weave.id), pw: res.warp.pitch, pf: res.weft.pitch,
      ww: w.ww, wf: w.wf, win: win, uid: "calc", S: 320,
    });
    const measured = res.warp.w_meas !== null || res.weft.w_meas !== null;
    $("weave-caption").textContent =
      `${Calc.WEAVES[res.weave.id].label}, finestra di ${fmt(win, 1)} mm, ordito in verticale. ` +
      (measured
        ? "Tow alle larghezze misurate: in ambra la superficie senza fibra."
        : "Tow alla larghezza richiesta: copertura piena per costruzione. Con una larghezza misurata vedi i gap.");
  }

  // ---------------------------------------------------------------------------
  // Vista Confronto
  // ---------------------------------------------------------------------------

  function compareBasis() {
    // Il confronto usa il tessuto della vista Calcolo come riferimento:
    // stessa grammatura, crimp, Vf e sezione. Cambiano solo filato e armatura.
    const inp = lastInput || buildCalcInput(state);
    const faw = lastResult ? lastResult.faw : 280;
    const num = (x, d) => (isFinite(x) ? x : d);
    return {
      faw: faw,
      crimp: num(inp.crimp_warp, 0),
      vf_yarn: num(inp.vf_yarn, 0.7),
      vf_lam: num(inp.vf_lam, 0.55),
      shape: inp.shape || "rect",
    };
  }

  function computeSlot(slot, basis) {
    const f = findFiber(slot.fiberId) || allFibers[0];
    if (!f) return null;
    const w = optionalNum(slot.wMeas);
    const res = Calc.compute({
      mode: "faw", faw_target: basis.faw, warp_share: 0.5, n_warp: 0, n_weft: 0, faw_meas: null,
      warp: { tex: f.tex, rho: f.density }, weft: { tex: f.tex, rho: f.density },
      crimp_warp: basis.crimp, crimp_weft: basis.crimp, tex_tol: 0,
      vf_yarn: basis.vf_yarn, vf_lam: basis.vf_lam, shape: basis.shape, weave: slot.weave,
      w_meas_warp: w, w_meas_weft: w,
    });
    return res.error ? null : { fiber: f, res: res };
  }

  const TAGS = "ABCD";

  // Righe della tabella di confronto: un'unica definizione serve la tabella
  // a schermo, il CSV e l'immagine esportata, così non possono divergere.
  function compareRows(items) {
    const anyMeas = items.some((x) => x.res.warp.w_meas !== null);
    const rows = [
      ["Armatura", (x) => Calc.WEAVES[x.res.weave.id].short],
      ["Titolo, tex", (x) => fmt(x.fiber.tex, 0)],
      ["Densità, g/cm³", (x) => fmt(x.fiber.density, 2)],
      ["Diametro equivalente, µm", (x) => fmt(Calc.equivalentDiameterUm(x.fiber.tex, x.fiber.filaments, x.fiber.density), 2)],
      ["Fili/cm", (x) => fmt(x.res.n_warp, 2)],
      ["Fili/pollice", (x) => fmt(x.res.warp.per_inch, 1)],
      ["Passo, mm", (x) => fmt(x.res.warp.pitch, 2)],
      ["Sezione di fibra del tow, mm²", (x) => fmt(x.res.warp.af, 3)],
      ["Rapporto, mm", (x) => fmt(x.res.warp.repeat_mm, 1)],
      ["Flottazione più lunga, mm", (x) => fmt(x.res.warp.float_max_mm, 1)],
      ["Legature/cm²", (x) => fmt(x.res.bindings_cm2, 1)],
      ["Indice di intreccio", (x) => fmt(x.res.weave.interlacing_warp, 2)],
      ["Spessore ply curato, mm", (x) => fmt(x.res.ply_thickness, 3)],
      ["Inserzioni di trama/m", (x) => fmt(x.res.picks_per_m, 0)],
    ];
    if (anyMeas) {
      rows.push(["Tow misurato, mm", (x) => fmt(x.res.warp.w_meas, 2)]);
      rows.push(["Gap tra tow, mm", (x) => fmt(x.res.warp.gap, 2)]);
      rows.push(["Copertura areale, %", (x) => (x.res.cover_fabric === null ? "—" : fmt(x.res.cover_fabric * 100, 0))]);
    }
    return rows;
  }

  function renderSlots() {
    // Ricostruisce le schede dei tessuti a confronto. Chiamata solo quando
    // cambia il NUMERO di schede: per le modifiche ai campi aggiorniamo solo
    // ciò che serve, altrimenti la tastiera si chiuderebbe a ogni carattere.
    const weaveOptions = (cur) => Calc.WEAVE_ORDER
      .map((id) => `<option value="${id}"${id === cur ? " selected" : ""}>${escapeHTML(Calc.WEAVES[id].label)}</option>`)
      .join("");
    $("slots").innerHTML = state.slots.map((slot, idx) => {
      const f = findFiber(slot.fiberId) || allFibers[0];
      return `
        <div class="slot" data-idx="${idx}">
          <div class="slot-head">
            <span><span class="tag">${TAGS[idx]}</span>Tessuto ${TAGS[idx]}</span>
            <button type="button" class="btn btn-small btn-quiet" data-act="remove"${state.slots.length <= MIN_SLOTS ? " disabled" : ""}>Togli</button>
          </div>
          <div class="rows">
            <label class="row"><span class="row-label">Fornitore</span><select data-role="supplier"></select></label>
            <label class="row"><span class="row-label">Filato</span><select data-role="fiber"></select></label>
            <label class="row"><span class="row-label">Armatura</span><select data-role="weave">${weaveOptions(slot.weave)}</select></label>
            <label class="row">
              <span class="row-label">Tow misurato</span>
              <span class="field"><input data-role="wmeas" type="text" inputmode="decimal" autocomplete="off" placeholder="facoltativo" value="${escapeHTML(slot.wMeas || "")}"><span class="unit">mm</span></span>
            </label>
          </div>
        </div>`;
    }).join("");
    // Le tendine dei filati si riempiono dopo, con le stesse funzioni del Calcolo.
    $("slots").querySelectorAll(".slot").forEach((card) => {
      const idx = Number(card.dataset.idx);
      const f = findFiber(state.slots[idx].fiberId) || allFibers[0];
      if (!f) return;
      fillSupplierSelect(card.querySelector('[data-role="supplier"]'), f.supplier);
      state.slots[idx].fiberId = fillFiberSelect(card.querySelector('[data-role="fiber"]'), f.supplier, f.id);
    });
    $("add-slot").disabled = state.slots.length >= MAX_SLOTS;
  }

  function computeCompare() {
    const basis = compareBasis();
    const items = state.slots
      .map((slot, idx) => {
        const r = computeSlot(slot, basis);
        return r ? Object.assign({ tag: TAGS[idx], idx: idx }, r) : null;
      })
      .filter(Boolean);
    return { basis: basis, items: items };
  }

  function renderCompare() {
    const { basis, items } = computeCompare();
    $("compare-basis").textContent =
      `Tutti bilanciati a ${fmt(basis.faw, 0)} g/m², crimp ${fmt(basis.crimp * 100, 1)} %, ` +
      `Vf del filo ${fmt(basis.vf_yarn, 2)}, Vf del laminato ${fmt(basis.vf_lam, 2)}: valori presi dalla scheda Calcolo. ` +
      "Disegni alla stessa scala, ordito in verticale.";

    const grid = $("compare-drawings");
    grid.replaceChildren();
    if (!items.length) return;
    const win = viewWindow(items.map((x) => x.res), 1);
    items.forEach((x) => {
      const fig = document.createElement("figure");
      fig.className = "cmp-figure";
      const svg = el("svg", { role: "img", "aria-label": `Tessuto ${x.tag}` });
      const w = drawnWidths(x.res);
      drawFabric(svg, {
        matrix: Calc.weaveMatrix(x.res.weave.id), pw: x.res.warp.pitch, pf: x.res.weft.pitch,
        ww: w.ww, wf: w.wf, win: win, uid: "cmp" + x.idx, S: 320, barK: 1.7,
      });
      fig.appendChild(svg);
      const cap = document.createElement("figcaption");
      cap.innerHTML = `<b><span class="tag">${x.tag}</span>${escapeHTML(fiberName(x.fiber))}</b>` +
        `<span class="meta">${escapeHTML(x.fiber.supplier)}, ${escapeHTML(Calc.WEAVES[x.res.weave.id].short)}, ` +
        `${fmt(x.res.n_warp, 2)} fili/cm</span>`;
      fig.appendChild(cap);
      grid.appendChild(fig);
    });

    const rows = compareRows(items);
    $("compare-table").querySelector("thead").innerHTML =
      "<tr><th scope=\"col\"></th>" + items.map((x) =>
        `<th scope="col"><span class="tag">${x.tag}</span>${escapeHTML(fiberName(x.fiber))}` +
        `<span class="sub-cell">${escapeHTML(x.fiber.supplier)}</span></th>`).join("") + "</tr>";
    $("compare-table").querySelector("tbody").innerHTML = rows
      .map(([label, get]) => `<tr><th scope="row">${escapeHTML(label)}</th>` +
        items.map((x) => `<td>${escapeHTML(get(x))}</td>`).join("") + "</tr>")
      .join("");
  }

  // --- Esportazione del confronto ------------------------------------------------

  async function shareOrDownload(blob, name, msgEl, okText) {
    // Su iPhone il foglio di condivisione (Salva su File, AirDrop, Mail,
    // WhatsApp) è il modo naturale di "scaricare". Se non c'è, link di download.
    msgEl.classList.remove("bad");
    try {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        msgEl.textContent = okText;
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return; // l'utente ha chiuso il foglio
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    msgEl.textContent = okText + " (" + name + ")";
  }

  function exportCSV() {
    const { basis, items } = computeCompare();
    if (!items.length) return;
    // Punto e virgola e virgola decimale: è ciò che Excel in italiano si aspetta.
    // Il BOM iniziale (\uFEFF) dice a Excel che il file è UTF-8 (µ, ², ³).
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [];
    lines.push([q("Trama, confronto a " + fmt(basis.faw, 0) + " g/m²")].join(";"));
    lines.push([q("")].concat(items.map((x) => q(x.tag + " " + x.fiber.supplier + " " + fiberName(x.fiber)))).join(";"));
    compareRows(items).forEach(([label, get]) => {
      lines.push([q(label)].concat(items.map((x) => q(get(x)))).join(";"));
    });
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv" });
    shareOrDownload(blob, `trama-confronto-${today()}.csv`, $("compare-msg"), "Tabella esportata");
  }

  function buildExportSVG() {
    // Un unico SVG con titolo, disegni e tabella: poi diventa un PNG.
    // Tutto con attributi espliciti (niente CSS): un'immagine non vede styles.css.
    const { basis, items } = computeCompare();
    const W = 1080, M = 40, GAP = 24;
    const cols = Math.min(items.length, 2);
    const cell = (W - 2 * M - (cols - 1) * GAP) / cols;
    const rowsDraw = Math.ceil(items.length / cols);
    const capH = 70;
    const table = compareRows(items);
    const rowH = 36;
    const labelW = 360;
    const colW = (W - 2 * M - labelW) / items.length;
    const top = 130;
    const tableTop = top + rowsDraw * (cell + capH + GAP) + 10;
    const H = tableTop + (table.length + 1) * rowH + M;

    const root = el("svg", { xmlns: SVG_NS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    root.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: "#F5F6F4" }));
    const text = (x, y, str, size, weight, fill, anchor) => {
      const t = el("text", {
        x: x, y: y, "font-size": size, "font-weight": weight || 400, fill: fill || COLORS.ink,
        "font-family": FONT, "text-anchor": anchor || "start",
      });
      t.textContent = str;
      root.appendChild(t);
    };
    text(M, 62, `Trama, confronto a ${fmt(basis.faw, 0)} g/m²`, 34, 700);
    text(M, 100, `Bilanciati, crimp ${fmt(basis.crimp * 100, 1)} %, Vf laminato ${fmt(basis.vf_lam, 2)}. ` +
      "Disegni alla stessa scala, ordito in verticale.", 20, 400, COLORS.ink2);

    const win = viewWindow(items.map((x) => x.res), 1);
    items.forEach((x, k) => {
      const cx = M + (k % cols) * (cell + GAP);
      const cy = top + Math.floor(k / cols) * (cell + capH + GAP);
      const svg = el("svg", { x: cx, y: cy, width: cell, height: cell });
      const w = drawnWidths(x.res);
      drawFabric(svg, {
        matrix: Calc.weaveMatrix(x.res.weave.id), pw: x.res.warp.pitch, pf: x.res.weft.pitch,
        ww: w.ww, wf: w.wf, win: win, uid: "exp" + k, S: cell,
      });
      root.appendChild(svg);
      root.appendChild(el("rect", { x: cx, y: cy, width: cell, height: cell, fill: "none", stroke: COLORS.line, "stroke-width": 1 }));
      text(cx, cy + cell + 32, `${x.tag}  ${x.fiber.supplier} ${fiberName(x.fiber)}`, 24, 600);
      text(cx, cy + cell + 58, `${Calc.WEAVES[x.res.weave.id].label}, ${fmt(x.res.n_warp, 2)} fili/cm, passo ${fmt(x.res.warp.pitch, 2)} mm`, 19, 400, COLORS.ink2);
    });

    // Tabella: righe alterne per guidare l'occhio lungo la riga.
    root.appendChild(el("rect", { x: M, y: tableTop, width: W - 2 * M, height: rowH, fill: "#FFFFFF" }));
    items.forEach((x, k) => text(M + labelW + (k + 1) * colW - 12, tableTop + 24, x.tag + "  " + fiberName(x.fiber), 18, 600, COLORS.ink, "end"));
    table.forEach(([label, get], r) => {
      const y = tableTop + (r + 1) * rowH;
      root.appendChild(el("rect", { x: M, y: y, width: W - 2 * M, height: rowH, fill: r % 2 ? "#FFFFFF" : "#ECEFF1" }));
      text(M + 12, y + 24, label, 18, 400, COLORS.ink2);
      items.forEach((x, k) => text(M + labelW + (k + 1) * colW - 12, y + 24, get(x), 18, 500, COLORS.ink, "end"));
    });
    return root;
  }

  function exportPNG() {
    const msg = $("compare-msg");
    const svg = buildExportSVG();
    const W = Number(svg.getAttribute("width"));
    const H = Number(svg.getAttribute("height"));
    const str = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([str], { type: "image/svg+xml" });
    const img = new Image();
    img.onload = () => {
      // Scala 2: l'immagine resta nitida sullo schermo Retina di chi la riceve.
      const canvas = document.createElement("canvas");
      canvas.width = W * 2;
      canvas.height = H * 2;
      const ctx = canvas.getContext("2d");
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, W, H);
      try {
        canvas.toBlob((blob) => {
          if (blob) shareOrDownload(blob, `trama-confronto-${today()}.png`, msg, "Immagine pronta");
          else shareOrDownload(svgBlob, `trama-confronto-${today()}.svg`, msg, "PNG non disponibile, esportato in SVG");
        }, "image/png");
      } catch (e) {
        // Alcuni browser "sporcano" il canvas dopo aver disegnato un SVG e ne
        // vietano l'esportazione: in quel caso consegniamo l'SVG, che resta
        // un'immagine apribile ovunque.
        shareOrDownload(svgBlob, `trama-confronto-${today()}.svg`, msg, "PNG non disponibile, esportato in SVG");
      }
    };
    img.onerror = () => shareOrDownload(svgBlob, `trama-confronto-${today()}.svg`, msg, "PNG non disponibile, esportato in SVG");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(str);
  }

  // ---------------------------------------------------------------------------
  // Vista Filati
  // ---------------------------------------------------------------------------

  function renderDbStatus() {
    // Conteggio sui soli filati ufficiali: i fornitori inventati aggiungendo
    // filati personali non devono gonfiare il numero.
    const nSup = new Set(seedFibers.map((f) => f.supplier)).size;
    const verified = seedFibers.filter((f) => f.verified).length;
    let txt = `${seedFibers.length} filati da ${nSup} fornitori`;
    if (dbMeta.updated) txt += ", aggiornato al " + dbMeta.updated;
    txt += `. Verificati: ${verified}.`;
    if (customFibers.length) txt += ` Personali: ${customFibers.length}.`;
    if (dbMeta.disclaimer) txt += " " + dbMeta.disclaimer;
    $("db-status").textContent = txt;

    $("supplier-list").innerHTML = suppliers().map((s) => `<option value="${escapeHTML(s)}">`).join("");
    $("custom-list").innerHTML = customFibers
      .map((f, i) =>
        `<li><span>${escapeHTML(f.supplier)} ${escapeHTML(fiberName(f))}, ${fmt(f.tex, 0)} tex, ` +
        `ρ ${fmt(f.density, 2)}</span>` +
        `<button type="button" class="btn btn-small btn-quiet" data-remove="${i}">Elimina</button></li>`)
      .join("");
  }

  function renderDbList() {
    // Ricerca per parole: "t700 12k" trova il T700S 12K. Ogni parola deve
    // comparire da qualche parte in fornitore + grado + K.
    const words = state.dbQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (f) => {
      const hay = `${f.supplier} ${f.grade} ${kLabel(f.filaments)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    };
    const html = suppliers().map((sup) => {
      const list = fibersOf(sup).filter(match);
      if (!list.length) return "";
      return `<div class="db-supplier"><h3>${escapeHTML(sup)}</h3><div class="rows">` +
        list.map((f) =>
          `<div class="db-row">` +
          `<div class="db-main"><span class="db-name">${escapeHTML(fiberName(f))}` +
          `${f.custom ? ' <span class="badge mine">tuo</span>' : ""}</span>` +
          `<span class="db-meta">${escapeHTML(fiberMeta(f))}</span></div>` +
          `<button type="button" class="btn btn-small" data-act="calc" data-id="${escapeHTML(f.id)}">Calcola</button>` +
          `<button type="button" class="btn btn-small" data-act="cmp" data-id="${escapeHTML(f.id)}">Confronta</button>` +
          `</div>`).join("") +
        `</div></div>`;
    }).join("");
    $("db-list").innerHTML = html || '<p class="hint">Nessun filato trovato. Puoi aggiungerlo qui sotto tra i filati personali.</p>';
  }

  function normalizeRecord(r) {
    // Porta un record importato alla forma attesa, o restituisce null.
    const num = (x) => (typeof x === "number" ? x : parseNum(x));
    const rec = {
      supplier: String(r.supplier || "").trim(),
      grade: String(r.grade || "").trim(),
      filaments: Math.round(num(r.filaments)),
      tex: num(r.tex),
      density: num(r.density),
      filament_diameter_um: isFinite(num(r.filament_diameter_um)) ? num(r.filament_diameter_um) : null,
      tensile_strength_mpa: isFinite(num(r.tensile_strength_mpa)) ? num(r.tensile_strength_mpa) : null,
      tensile_modulus_gpa: isFinite(num(r.tensile_modulus_gpa)) ? num(r.tensile_modulus_gpa) : null,
      source: String(r.source || "Aggiunto dall'app"),
      verified: r.verified === true,
      notes: String(r.notes || ""),
    };
    const ok =
      rec.supplier && rec.grade && rec.filaments > 0 && rec.tex > 0 &&
      rec.density >= 1.6 && rec.density <= 2.25; // stesso intervallo di db_tools.py
    return ok ? rec : null;
  }

  function addCustom(rec) {
    // Rifiuta i doppioni (stesso fornitore, grado, filamenti).
    const id = fiberId(rec);
    if (allFibers.some((f) => fiberId(f) === id)) return false;
    customFibers.push(rec);
    saveJSON(KEY_CUSTOM, customFibers);
    mergeFibers();
    return true;
  }

  function afterDbChange() {
    syncFiberSelects();
    renderDbStatus();
    renderDbList();
    renderSlots();
    recompute();
  }

  async function exportDatabase() {
    // Database ufficiale + filati personali, nello stesso formato di
    // fibers.json: si può rimettere nel repo o reimportare su un altro iPhone.
    const clean = (f) => {
      const c = Object.assign({}, f);
      delete c.id;
      delete c.custom;
      return c;
    };
    const payload = {
      schema_version: 1,
      updated: today(),
      disclaimer: dbMeta.disclaimer,
      fibers: seedFibers.map(clean).concat(customFibers.map(clean)),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    shareOrDownload(blob, `trama-fibre-${payload.updated}.json`, $("io-msg"), "Database esportato");
  }

  // ---------------------------------------------------------------------------
  // Ciclo principale
  // ---------------------------------------------------------------------------

  function recompute() {
    saveJSON(KEY_STATE, state);
    const inp = buildCalcInput(state);
    const res = Calc.compute(inp);
    showError(res.error);
    lastInput = inp;
    if (!res.error) lastResult = res;
    renderKpis(res, inp);
    renderResultTable(res);
    renderFacts(res, inp);
    renderCrimpImplied(res, inp);
    drawCalc(res);
    if (!res.error) $("weave-note").textContent = weaveNote(res.weave.id, res.weave);
    // Il confronto dipende dal Calcolo (grammatura, crimp, Vf): lo ridisegniamo
    // solo se è visibile, per non rallentare la digitazione nel Calcolo.
    if (state.view === "compare") renderCompare();
  }

  function syncFiberSelects() {
    const warp = findFiber(state.warpId) || allFibers[0];
    if (warp) {
      fillSupplierSelect($("warp-supplier"), warp.supplier);
      state.warpId = fillFiberSelect($("warp-fiber"), warp.supplier, warp.id);
    }
    const weft = findFiber(state.weftId) || warp;
    if (weft) {
      fillSupplierSelect($("weft-supplier"), weft.supplier);
      state.weftId = fillFiberSelect($("weft-fiber"), weft.supplier, weft.id);
    }
    $("weft-block").hidden = !state.weftDifferent;
    renderFiberInfo($("warp-info"), findFiber(state.warpId));
    renderFiberInfo($("weft-info"), findFiber(state.weftId));
  }

  function syncModeVisibility() {
    $("faw-inputs").hidden = state.mode !== "faw";
    $("density-inputs").hidden = state.mode !== "density";
  }

  const SUBTITLES = {
    calc: "Grammatura, fili/cm e armatura di tessuti in fibra di carbonio",
    compare: "Filati e armature a confronto, stessa grammatura e stessa scala",
    db: "Titolo e densità dei filati, divisi per fornitore",
  };

  function setView(v) {
    state.view = v;
    ["calc", "compare", "db"].forEach((name) => {
      $("view-" + name).hidden = name !== v;
    });
    document.querySelectorAll(".tab").forEach((t) => {
      if (t.dataset.view === v) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    $("view-sub").textContent = SUBTITLES[v];
    if (v === "compare") renderCompare();
    if (v === "db") renderDbList();
    saveJSON(KEY_STATE, state);
    window.scrollTo(0, 0);
  }

  function bindText(id, key) {
    const input = $(id);
    input.value = state[key];
    input.addEventListener("input", () => {
      state[key] = input.value;
      recompute();
    });
  }

  function bindEvents() {
    [
      ["faw", "faw"], ["share", "share"], ["n-warp", "nWarp"], ["n-weft", "nWeft"], ["faw-meas", "fawMeas"],
      ["crimp-warp", "crimpWarp"], ["crimp-weft", "crimpWeft"], ["tex-tol", "texTol"],
      ["vf", "vf"], ["vf-lam", "vfLam"], ["w-warp", "wWarp"], ["w-weft", "wWeft"],
    ].forEach(([id, key]) => bindText(id, key));

    $("shape").value = state.shape;
    $("shape").addEventListener("change", (e) => {
      state.shape = e.target.value;
      recompute();
    });

    // Armatura: un solo ascoltatore sul contenitore (delega degli eventi).
    $("weave-picker").addEventListener("click", (e) => {
      const b = e.target.closest("[data-weave]");
      if (!b) return;
      state.weave = b.dataset.weave;
      document.querySelectorAll(".weave-chip").forEach((c) =>
        c.setAttribute("aria-checked", String(c.dataset.weave === state.weave)));
      recompute();
    });

    $("warp-supplier").addEventListener("change", (e) => {
      state.warpId = fillFiberSelect($("warp-fiber"), e.target.value, null);
      if (!state.weftDifferent) state.weftId = state.warpId;
      syncFiberSelects();
      recompute();
    });
    $("warp-fiber").addEventListener("change", (e) => {
      state.warpId = e.target.value;
      if (!state.weftDifferent) state.weftId = state.warpId;
      syncFiberSelects();
      recompute();
    });
    $("weft-supplier").addEventListener("change", (e) => {
      state.weftId = fillFiberSelect($("weft-fiber"), e.target.value, null);
      syncFiberSelects();
      recompute();
    });
    $("weft-fiber").addEventListener("change", (e) => {
      state.weftId = e.target.value;
      syncFiberSelects();
      recompute();
    });

    $("weft-different").checked = state.weftDifferent;
    $("weft-different").addEventListener("change", (e) => {
      state.weftDifferent = e.target.checked;
      // Si parte dal filato di ordito: il risultato non salta finché
      // l'utente non sceglie qualcos'altro.
      if (state.weftDifferent) state.weftId = state.warpId;
      syncFiberSelects();
      recompute();
    });

    // Cambio modalità: portiamo con noi i valori attuali, così le due
    // modalità mostrano lo stesso tessuto invece di ripartire da capo.
    document.querySelectorAll('input[name="mode"]').forEach((r) => {
      r.checked = r.value === state.mode;
      r.addEventListener("change", (e) => {
        const newMode = e.target.value;
        if (lastResult) {
          if (newMode === "density") {
            state.nWarp = fmtInput(lastResult.n_warp, 2);
            state.nWeft = fmtInput(lastResult.n_weft, 2);
            $("n-warp").value = state.nWarp;
            $("n-weft").value = state.nWeft;
          } else {
            state.faw = fmtInput(lastResult.faw, 1);
            state.share = fmtInput((lastResult.faw_warp / lastResult.faw) * 100, 1);
            $("faw").value = state.faw;
            $("share").value = state.share;
          }
        }
        state.mode = newMode;
        syncModeVisibility();
        recompute();
      });
    });

    // --- Confronto ---
    const slotOf = (e) => {
      const card = e.target.closest(".slot");
      return card ? { card: card, idx: Number(card.dataset.idx) } : null;
    };
    $("slots").addEventListener("change", (e) => {
      const s = slotOf(e);
      if (!s) return;
      const slot = state.slots[s.idx];
      const role = e.target.dataset.role;
      if (role === "supplier") {
        slot.fiberId = fillFiberSelect(s.card.querySelector('[data-role="fiber"]'), e.target.value, null);
      } else if (role === "fiber") {
        slot.fiberId = e.target.value;
      } else if (role === "weave") {
        slot.weave = e.target.value;
      } else {
        return;
      }
      saveJSON(KEY_STATE, state);
      renderCompare();
    });
    $("slots").addEventListener("input", (e) => {
      const s = slotOf(e);
      if (!s || e.target.dataset.role !== "wmeas") return;
      state.slots[s.idx].wMeas = e.target.value;
      saveJSON(KEY_STATE, state);
      renderCompare();
    });
    $("slots").addEventListener("click", (e) => {
      const b = e.target.closest('[data-act="remove"]');
      const s = slotOf(e);
      if (!b || !s || state.slots.length <= MIN_SLOTS) return;
      state.slots.splice(s.idx, 1);
      saveJSON(KEY_STATE, state);
      renderSlots();
      renderCompare();
    });
    $("add-slot").addEventListener("click", () => {
      if (state.slots.length >= MAX_SLOTS) return;
      // Il nuovo tessuto parte dal filato e dall'armatura del Calcolo.
      state.slots.push({ fiberId: state.warpId, weave: state.weave, wMeas: "" });
      saveJSON(KEY_STATE, state);
      renderSlots();
      renderCompare();
    });
    $("export-png").addEventListener("click", exportPNG);
    $("export-csv").addEventListener("click", exportCSV);

    // --- Filati ---
    $("db-search").value = state.dbQuery;
    $("db-search").addEventListener("input", (e) => {
      state.dbQuery = e.target.value;
      saveJSON(KEY_STATE, state);
      renderDbList();
    });
    $("db-list").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.act === "calc") {
        state.warpId = id;
        if (!state.weftDifferent) state.weftId = id;
        syncFiberSelects();
        recompute();
        setView("calc");
      } else {
        if (state.slots.length < MAX_SLOTS) {
          state.slots.push({ fiberId: id, weave: state.weave, wMeas: "" });
        } else {
          // Pieno: sostituiamo l'ultimo invece di rifiutare, e lo diciamo.
          state.slots[MAX_SLOTS - 1].fiberId = id;
          $("compare-msg").textContent = `Il confronto ha già ${MAX_SLOTS} tessuti: ho sostituito il ${TAGS[MAX_SLOTS - 1]}.`;
        }
        renderSlots();
        setView("compare");
      }
    });

    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => setView(t.dataset.view)));

    bindDatabaseEvents();
  }

  function bindDatabaseEvents() {
    $("add-form").addEventListener("submit", (e) => {
      e.preventDefault(); // nessun invio di pagina: tutto resta sul telefono
      const msg = $("add-msg");
      const rec = normalizeRecord({
        supplier: $("add-supplier").value,
        grade: $("add-grade").value,
        filaments: parseNum($("add-k").value) * 1000,
        tex: $("add-tex").value,
        density: $("add-rho").value,
        filament_diameter_um: $("add-d").value,
      });
      msg.classList.remove("bad");
      if (!rec) {
        msg.textContent = "Servono fornitore, grado, filamenti, tex e una densità tra 1,6 e 2,25 g/cm³.";
        msg.classList.add("bad");
        return;
      }
      if (!addCustom(rec)) {
        msg.textContent = "Questo filato esiste già nel database.";
        msg.classList.add("bad");
        return;
      }
      // Controllo di coerenza immediato, come in db_tools.py.
      let extra = "";
      if (rec.filament_diameter_um) {
        const texGeo = Calc.texFromGeometry(rec.filaments, rec.filament_diameter_um, rec.density);
        const dev = (texGeo - rec.tex) / rec.tex;
        if (Math.abs(dev) > 0.1) {
          extra = ` Attenzione: dal diametro ci si aspetterebbero ${fmt(texGeo, 0)} tex (${fmt(dev * 100, 0)} %).`;
        }
      }
      msg.textContent = "Filato aggiunto." + extra;
      e.target.reset();
      afterDbChange();
    });

    $("custom-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-remove]");
      if (!btn) return;
      customFibers.splice(Number(btn.dataset.remove), 1);
      saveJSON(KEY_CUSTOM, customFibers);
      mergeFibers();
      afterDbChange();
    });

    $("reset-custom").addEventListener("click", () => {
      if (!customFibers.length) return;
      if (!window.confirm("Rimuovere tutti i filati personali? Esportali prima se vuoi conservarli.")) return;
      customFibers = [];
      saveJSON(KEY_CUSTOM, customFibers);
      mergeFibers();
      afterDbChange();
    });

    $("export-db").addEventListener("click", exportDatabase);

    $("import-db").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      const msg = $("io-msg");
      msg.classList.remove("bad");
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        // Accettiamo sia il formato completo {fibers: [...]} sia un array.
        const list = Array.isArray(data) ? data : Array.isArray(data.fibers) ? data.fibers : [];
        let added = 0, skipped = 0;
        list.forEach((r) => {
          const rec = normalizeRecord(r);
          if (rec && addCustom(rec)) added++;
          else skipped++;
        });
        msg.textContent = `Importati ${added} filati, scartati ${skipped} (doppioni o dati incompleti).`;
        afterDbChange();
      } catch (err) {
        msg.textContent = "File non leggibile: serve un JSON con un elenco di filati.";
        msg.classList.add("bad");
      }
      e.target.value = ""; // permette di reimportare lo stesso file
    });
  }

  // ---------------------------------------------------------------------------
  // Avvio
  // ---------------------------------------------------------------------------

  async function start() {
    await loadDatabase();
    renderWeavePicker();
    syncFiberSelects();
    syncModeVisibility();
    bindEvents();
    renderSlots();
    renderDbStatus();
    recompute();
    setView(state.view);
  }

  // Service worker: app disponibile offline dopo la prima apertura.
  // Registrato dopo "load" per non rallentare il primo disegno della pagina.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        /* es. pagina aperta da file:// — l'app funziona, solo non offline */
      });
    });
  }

  start();
})();
