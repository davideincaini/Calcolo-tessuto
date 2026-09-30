/* =============================================================================
 * app.js — interfaccia di Trama (v2)
 * -----------------------------------------------------------------------------
 * Questo file NON contiene formule: legge i campi, chiama FabricCalc.compute()
 * (definito in calc.js) e disegna i risultati. Tenere separati "cosa si
 * calcola" e "come si mostra" permette di testare i calcoli senza browser.
 *
 * Flusso a ogni modifica di un campo:
 *   evento → aggiorna `state` → salva → costruisce gli ingressi
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

  // Chiavi di localStorage. I FILATI PERSONALI restano su "v1": stesso formato
  // di Trama v1, così quelli già inseriti compaiono anche qui.
  const KEY_STATE = "trama.state.v2";
  const KEY_CUSTOM = "trama.customFibers.v1";

  // Id speciale per "filato con valori inseriti a mano": non esiste nel
  // database, quindi non può collidere con un id vero (fornitore|grado|filamenti).
  const INPUT_ID = "__input__";

  const MAX_YARNS_VIEW = 40; // fili per direzione in un disegno: limite per la fluidità

  // Parametri che l'interfaccia non chiede ma che il motore richiede. Stanno
  // qui, in un solo posto. Sezione rettangolare: lo spessore nativo t₀ va letto
  // come spessore MEDIO equivalente del tow. vf_lam compare solo nell'etichetta
  // dello spessore del ply, che lo dichiara.
  const FIXED = { shape: "rect", vf_lam: 0.55 };

  // Valori iniziali di buchi e spreading. φ = 80 % è la tua ipotesi di partenza.
  // t₀ = 0,11 mm: con φ 0,8 rende largo ~5 mm un 12K da 800 tex, la larghezza
  // di un tow 12K convenzionale citata in letteratura (El-Dessouky e Lawrence).
  // Per 3K e 6K NON è verificato: va tarato con una misura.
  const PHI_DEFAULT = "80";
  const T0_DEFAULT = "0,11";

  // Colori del disegno. Ripetono la palette di styles.css perché il disegno
  // viene anche ESPORTATO come immagine, e lì il foglio di stile non arriva.
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

  const emptyInput = () => ({ tex: "", rho: "", k: "" });
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // Un filato nello stato è sempre { id, input }: `id` punta al database,
  // oppure vale INPUT_ID e allora contano i valori scritti in `input`.
  // Salviamo le STRINGHE dei campi: "1,78" resta come l'ha scritto l'utente.
  const DEFAULTS = {
    view: "calc",
    warp: { id: "Toray|T300|3000", input: emptyInput() },
    weft: { id: "Toray|T300|3000", input: emptyInput() },
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
    phi: PHI_DEFAULT,
    t0Warp: T0_DEFAULT,
    t0Weft: T0_DEFAULT,
    // Confronto predefinito: quello della discussione da cui nasce l'app,
    // un 6K standard contro un 6K a filamento fine, entrambi 5H a 280 g/m².
    cmp: {
      faw: "280",
      crimp: "1",
      phi: PHI_DEFAULT,
      a: { id: "Toray|T300|6000", weave: "satin5", t0: T0_DEFAULT, input: emptyInput() },
      b: { id: "Toray|T800H|6000", weave: "satin5", t0: T0_DEFAULT, input: emptyInput() },
    },
    dbQuery: "",
  };

  let state = loadState();
  let dbMeta = { disclaimer: "", updated: "" };
  let seedFibers = [];   // da fibers.json (sola lettura)
  let customFibers = []; // filati personali, salvati sul telefono
  let allFibers = [];    // unione delle due liste, con un id per ciascuna
  let lastResult = null; // ultimo risultato valido del Calcolo (per il cambio modalità)

  function loadState() {
    // Uniamo i valori salvati ai predefiniti e controlliamo la forma di ciò
    // che è annidato: uno stato salvato da una versione precedente (con altri
    // campi) non deve rompere l'app, al massimo si riparte dai predefiniti.
    const s = Object.assign(clone(DEFAULTS), loadJSON(KEY_STATE, {}));
    const okSpec = (x) => x && typeof x.id === "string" && x.input && typeof x.input === "object";
    if (!okSpec(s.warp)) s.warp = clone(DEFAULTS.warp);
    if (!okSpec(s.weft)) s.weft = clone(DEFAULTS.weft);
    const c = s.cmp;
    const okCmp = c && typeof c.faw === "string" && typeof c.crimp === "string" &&
      okSpec(c.a) && okSpec(c.b) && Calc.WEAVES[c.a.weave] && Calc.WEAVES[c.b.weave];
    if (!okCmp) s.cmp = clone(DEFAULTS.cmp);
    // Object.assign completa solo il primo livello: i campi nuovi dentro
    // cmp (φ, spessori) li aggiungiamo a mano se mancano.
    if (typeof s.cmp.phi !== "string") s.cmp.phi = PHI_DEFAULT;
    ["a", "b"].forEach((k) => {
      if (typeof s.cmp[k].t0 !== "string") s.cmp[k].t0 = T0_DEFAULT;
    });
    if (!Calc.WEAVES[s.weave]) s.weave = DEFAULTS.weave;
    if (!["calc", "compare", "db"].includes(s.view)) s.view = "calc";
    // Campi della versione precedente (confronto a 4 tessuti, Filo e laminato):
    // li togliamo perché non restino nel salvataggio per sempre.
    ["warpId", "weftId", "slots", "vf", "shape", "vfLam", "wWarp", "wWeft"].forEach((k) => delete s[k]);
    return s;
  }

  function saveState() {
    saveJSON(KEY_STATE, state);
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
    const x = parseNum(str);
    return isFinite(x) && x > 0 ? x : null;
  }

  function parseFilaments(str) {
    // Accetta i modi in cui si scrive davvero: "6", "6K", "6k", "1,5K"
    // (migliaia) oppure il conteggio intero "6000". Soglia 100: nessun tow
    // di carbonio ha meno di 100 filamenti, né più di 99K scritto in migliaia.
    const s = String(str || "").trim().toLowerCase().replace(/\s*k$/, "");
    const x = parseNum(s);
    if (!(x > 0)) return null;
    return Math.round(x >= 100 ? x : x * 1000);
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
    // Per riscrivere un numero in un campo: senza separatore delle migliaia
    // (il punto verrebbe riletto come decimale).
    return fmt(x, digits).replace(/\./g, "");
  }

  function plainNum(x) {
    // Numero "come lo scriverebbe una persona": 1.78 → "1,78", 400 → "400".
    return String(x).replace(".", ",");
  }

  function escapeHTML(s) {
    // I dati importati da file sono input non fidato: mai inserirli come HTML
    // senza "disinnescare" < > & " '.
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function kLabel(filaments) {
    if (!filaments) return "";
    if (filaments % 1000 === 0) return filaments / 1000 + "K";
    if (filaments % 500 === 0) return fmt(filaments / 1000, 1) + "K";
    return String(filaments);
  }

  function fiberId(f) {
    return [f.supplier, f.grade, f.filaments].join("|");
  }

  function fiberName(f) {
    if (f.input) return "A mano, " + fmt(f.tex, 0) + " tex" + (f.filaments ? " " + kLabel(f.filaments) : "");
    return f.grade + " " + kLabel(f.filaments);
  }

  function fullName(f) {
    // Nome con fornitore, per CSV e immagine; i valori a mano non hanno fornitore.
    return f.input ? fiberName(f) : f.supplier + " " + fiberName(f);
  }

  function findFiber(id) {
    return allFibers.find((f) => f.id === id) || null;
  }

  function yarnOf(spec) {
    // Dal filato "come sta nello stato" al filato "come serve ai calcoli".
    // Per i valori a mano costruiamo un record con la stessa forma di quelli
    // del database: il resto del codice non deve sapere da dove arriva.
    if (spec.id !== INPUT_ID) return findFiber(spec.id);
    const tex = parseNum(spec.input.tex);
    const rho = parseNum(spec.input.rho);
    if (!(tex > 0) || !(rho > 0)) return null;
    return {
      id: INPUT_ID, input: true, custom: true, supplier: "Valori a mano", grade: "",
      filaments: parseFilaments(spec.input.k), tex: tex, density: rho,
      filament_diameter_um: null, tensile_modulus_gpa: null, source: "", notes: "", verified: false,
    };
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
      showError("Database non disponibile. Apri l'app almeno una volta con la connessione attiva, " +
        "oppure usa «Valori a mano» nel menu Fornitore.");
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
    // Riassunto in una riga. Il diametro equivalente dice quanto dovrebbe
    // valere d per essere coerente con tex e densità: se differisce molto da
    // quello in scheda, di solito è la scheda ad arrotondare.
    const parts = [fmt(f.tex, 0) + " tex", "ρ " + fmt(f.density, 2) + " g/cm³"];
    if (f.filaments) {
      const dEq = Calc.equivalentDiameterUm(f.tex, f.filaments, f.density);
      const d = f.filament_diameter_um;
      parts.push(d ? `d ${fmt(d, 1)} µm (da tex ${fmt(dEq, 2)})` : `d da tex ${fmt(dEq, 2)} µm`);
    }
    if (f.tensile_modulus_gpa) parts.push("E " + fmt(f.tensile_modulus_gpa, 0) + " GPa");
    return parts.join(", ");
  }

  // ---------------------------------------------------------------------------
  // Selettore di filato (componente riutilizzato 4 volte)
  // ---------------------------------------------------------------------------
  // Un solo pezzo di codice per ordito, trama e le due colonne del confronto:
  // se un giorno cambia il modo di scegliere un filato, cambia ovunque.
  // Ogni selettore riceve una funzione `getSpec` (dove sta il suo filato nello
  // stato) e una `onChange` (cosa ricalcolare quando cambia).

  const pickers = {}; // nome → { el, getSpec, onChange, brief }

  function supplierOptions(current) {
    return suppliers()
      .map((s) => `<option value="${escapeHTML(s)}"${s === current ? " selected" : ""}>${escapeHTML(s)}</option>`)
      .join("") +
      `<option value="${INPUT_ID}"${current === INPUT_ID ? " selected" : ""}>Valori a mano</option>`;
  }

  function renderPicker(name) {
    const p = pickers[name];
    const spec = p.getSpec();
    const isInput = spec.id === INPUT_ID;
    const f = isInput ? null : findFiber(spec.id) || allFibers[0];
    if (!isInput && !f) spec.id = INPUT_ID; // database vuoto: restano i valori a mano
    const inputRow = (role, label, unit, placeholder, inputmode) =>
      `<label class="row" data-when="input"><span class="row-label">${label}</span>` +
      `<span class="field"><input data-role="${role}" type="text" inputmode="${inputmode}" autocomplete="off"` +
      ` placeholder="${placeholder}" value="${escapeHTML(spec.input[role] || "")}"><span class="unit">${unit}</span></span></label>`;
    p.el.innerHTML =
      `<div class="rows">` +
      `<label class="row"><span class="row-label">Fornitore</span><select data-role="supplier">` +
      supplierOptions(spec.id === INPUT_ID ? INPUT_ID : f.supplier) + `</select></label>` +
      `<label class="row" data-when="db"><span class="row-label">Filato</span><select data-role="fiber"></select></label>` +
      inputRow("tex", "Titolo", "tex", "", "decimal") +
      inputRow("rho", "Densità", "g/cm³", "", "decimal") +
      // inputmode "text": la tastiera deve permettere di scrivere "6K".
      inputRow("k", "Filamenti", "&nbsp;", "facoltativo", "text") +
      `</div>` +
      `<div class="fiber-info" data-role="info"></div>` +
      `<div class="picker-actions" data-when="input">` +
      `<button type="button" class="btn btn-small" data-role="save">Salva nei filati personali</button></div>`;
    if (spec.id !== INPUT_ID) {
      spec.id = fillFiberSelect(p.el.querySelector('[data-role="fiber"]'), f.supplier, f.id);
    }
    syncPicker(name);
  }

  function syncPicker(name, message) {
    // Aggiorna solo visibilità e riga informativa, SENZA ricostruire i campi:
    // ricostruirli a ogni carattere chiuderebbe la tastiera dell'iPhone.
    const p = pickers[name];
    const spec = p.getSpec();
    const isInput = spec.id === INPUT_ID;
    p.el.querySelectorAll("[data-when]").forEach((node) => {
      node.hidden = node.dataset.when !== (isInput ? "input" : "db");
    });
    const info = p.el.querySelector('[data-role="info"]');
    if (message) {
      info.textContent = message;
      return;
    }
    const f = yarnOf(spec);
    if (!f) {
      info.textContent = isInput ? "Inserisci almeno titolo e densità." : "";
      return;
    }
    if (isInput) {
      info.textContent = fiberMeta(f) + (f.filaments ? "" : ". Con i filamenti vedi anche il diametro equivalente.");
      return;
    }
    const badge = f.custom
      ? '<span class="badge mine">tuo</span>'
      : f.verified ? '<span class="badge ok">verificato</span>' : '<span class="badge">da verificare</span>';
    // Nelle colonne strette del confronto basta l'essenziale; fonte e note
    // restano visibili nel Calcolo e nella scheda Filati.
    const extra = p.brief ? "" :
      (f.source ? "<br>Fonte: " + escapeHTML(f.source) : "") + (f.notes ? "<br>" + escapeHTML(f.notes) : "");
    const meta = p.brief ? `${fmt(f.tex, 0)} tex, ρ ${fmt(f.density, 2)}` : fiberMeta(f);
    info.innerHTML = escapeHTML(meta) + " " + badge + extra;
  }

  function registerPicker(name, el, getSpec, onChange, brief) {
    pickers[name] = { el: el, getSpec: getSpec, onChange: onChange, brief: !!brief };

    el.addEventListener("change", (e) => {
      const spec = getSpec();
      const role = e.target.dataset.role;
      if (role === "supplier") {
        if (e.target.value === INPUT_ID) {
          // Precompiliamo con il filato appena lasciato: di solito si parte
          // da un filato noto e si corregge un numero (es. il tex misurato).
          const prev = findFiber(spec.id);
          if (prev && !spec.input.tex && !spec.input.rho) {
            spec.input = { tex: plainNum(prev.tex), rho: plainNum(prev.density), k: kLabel(prev.filaments) };
          }
          spec.id = INPUT_ID;
        } else {
          const first = fibersOf(e.target.value)[0];
          spec.id = first ? first.id : spec.id;
        }
        renderPicker(name); // cambio di menu: ricostruire qui non disturba la tastiera
      } else if (role === "fiber") {
        spec.id = e.target.value;
        syncPicker(name);
      } else {
        return;
      }
      onChange();
    });

    el.addEventListener("input", (e) => {
      const role = e.target.dataset.role;
      if (role !== "tex" && role !== "rho" && role !== "k") return;
      getSpec().input[role] = e.target.value;
      syncPicker(name);
      onChange();
    });

    el.addEventListener("click", (e) => {
      if (e.target.dataset.role === "save") saveInputAsCustom(name);
    });
  }

  function saveInputAsCustom(name) {
    // Trasforma i valori a mano in un filato personale, riutilizzabile ovunque.
    const p = pickers[name];
    const spec = p.getSpec();
    const f = yarnOf(spec);
    if (!f) return syncPicker(name, "Per salvarlo servono titolo e densità.");
    if (!f.filaments) return syncPicker(name, "Per salvarlo serve anche il numero di filamenti, es. 6K.");
    const label = window.prompt("Nome del filato, es. il grado indicato in scheda", "");
    if (label === null) return; // l'utente ha annullato
    const rec = normalizeRecord({
      supplier: "Personali",
      grade: label.trim() || fmt(f.tex, 0) + " tex",
      filaments: f.filaments,
      tex: f.tex,
      density: f.density,
      source: "Inserito a mano nell'app",
    });
    if (!rec) {
      return syncPicker(name, "Densità fuori da 1,6–2,25 g/cm³: il filato resta usabile qui, ma nel database dei carboni non si salva.");
    }
    if (!addCustom(rec)) return syncPicker(name, "Esiste già un filato personale con questo nome e questi filamenti.");
    spec.id = "custom|" + fiberId(rec);
    spec.input = emptyInput();
    afterDbChange();
  }

  function renderAllPickers() {
    Object.keys(pickers).forEach(renderPicker);
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
    //   o.ww/wf   larghezza disegnata dei tow [mm]; se manca, quanto il passo
    //   o.uid     prefisso unico per gli id: più disegni stanno nella stessa
    //             pagina e un id duplicato farebbe usare il pattern sbagliato
    //   o.S       lato in unità SVG;  o.barK  ingrandimento della barra di scala
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

    svg.appendChild(el("rect", { x: 0, y: 0, width: S, height: S, fill: COLORS.resin }));

    const M = o.matrix;
    const Rw = M.length;
    const Rp = M[0].length;
    const nx = Math.min(Math.ceil(o.win / o.pw) + 1, MAX_YARNS_VIEW + 2);
    const ny = Math.min(Math.ceil(o.win / o.pf) + 1, MAX_YARNS_VIEW + 2);
    const cx = (i) => (i + 0.5) * o.pw * s; // centro dell'ordito i
    const cy = (j) => (j + 0.5) * o.pf * s; // centro della trama j
    // Un tow più largo del passo in pianta non può sovrapporsi al vicino
    // (in realtà si comprime): lo disegniamo largo quanto il passo.
    const hw = (Math.min(o.ww || o.pw, o.pw) * s) / 2;
    const hf = (Math.min(o.wf || o.pf, o.pf) * s) / 2;
    const edge = { stroke: COLORS.edge, "stroke-width": 0.6 };

    // Trama sotto (righe intere), ordito sopra (colonne intere)...
    for (let j = 0; j < ny; j++) {
      svg.appendChild(el("rect", Object.assign({ x: 0, y: cy(j) - hf, width: S, height: 2 * hf, fill: fillWeft }, edge)));
    }
    for (let i = 0; i < nx; i++) {
      svg.appendChild(el("rect", Object.assign({ x: cx(i) - hw, y: 0, width: 2 * hw, height: S, fill: fillWarp }, edge)));
    }
    // ...poi, dove la matrice dice "trama sopra", un tratto di trama SOPRA
    // l'ordito. È l'armatura: stesso codice per tela, saie e satin.
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (M[i % Rw][j % Rp] === 0) {
          svg.appendChild(el("rect", Object.assign({ x: cx(i) - hw, y: cy(j) - hf, width: 2 * hw, height: 2 * hf, fill: fillWeft }, edge)));
        }
      }
    }

    // Barra di scala in mm, su fondo bianco per restare leggibile. Cresce con
    // il disegno (export) e con o.barK (disegni a metà larghezza dello schermo).
    const L = niceScale(o.win / 4);
    const barPx = L * s;
    const k = (S / 320) * (o.barK || 1);
    const g = el("g", { transform: `translate(${10 * k} ${S - 34 * k}) scale(${k})` });
    g.appendChild(el("rect", { x: 0, y: 0, width: barPx / k + 20, height: 26, rx: 6, fill: COLORS.scaleBg }));
    g.appendChild(el("rect", { x: 10, y: 17, width: barPx / k, height: 3, fill: COLORS.ink }));
    const label = el("text", { x: 10, y: 13, fill: COLORS.ink, "font-size": 11, "font-weight": 600, "font-family": FONT });
    label.textContent = fmt(L, L < 1 ? 1 : 0) + " mm";
    g.appendChild(label);
    svg.appendChild(g);
  }

  function towWidths(res) {
    // Larghezza da disegnare: quella nativa stimata se c'è, altrimenti il passo.
    return {
      ww: res.warp.w_tow !== null ? res.warp.w_tow : res.warp.pitch,
      wf: res.weft.w_tow !== null ? res.weft.w_tow : res.weft.pitch,
    };
  }

  function viewWindow(results, repeats) {
    // Lato della finestra in mm, comune a tutti i risultati passati:
    //  - contiene `repeats` rapporti dell'armatura più ampia e almeno 6 passi
    //    del filo più rado;
    //  - non richiede più di MAX_YARNS_VIEW fili per direzione al filo più
    //    fitto (il disegno diventerebbe lento e illeggibile).
    let rep = 0, pMax = 0, pMin = Infinity;
    results.forEach((r) => {
      rep = Math.max(rep, r.warp.repeat_mm, r.weft.repeat_mm);
      pMax = Math.max(pMax, r.warp.pitch, r.weft.pitch);
      pMin = Math.min(pMin, r.warp.pitch, r.weft.pitch);
    });
    return Math.min(Math.max(repeats * rep, 6 * pMax), MAX_YARNS_VIEW * pMin);
  }

  function weaveChipSVG(id) {
    // "Carta tecnica" in miniatura: quadratino scuro = ordito sopra.
    const M = Calc.weaveMatrix(id);
    const R = M.length;
    const N = R <= 5 ? 2 * R : R; // rapporti interi: 2 per quelli piccoli, 1 per 8×8
    let cells = "";
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const on = M[i % R][j % R] === 1;
        cells += `<rect x="${i + 0.06}" y="${j + 0.06}" width="0.88" height="0.88" fill="${on ? COLORS.chipOn : COLORS.chipOff}"/>`;
      }
    }
    return `<svg viewBox="0 0 ${N} ${N}" aria-hidden="true">${cells}</svg>`;
  }

  function weaveOptions(current) {
    return Calc.WEAVE_ORDER
      .map((id) => `<option value="${id}"${id === current ? " selected" : ""}>${escapeHTML(Calc.WEAVES[id].label)}</option>`)
      .join("");
  }

  // ---------------------------------------------------------------------------
  // Vista Calcolo
  // ---------------------------------------------------------------------------

  function showError(msg) {
    const e = $("error");
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  function buildCalcInput() {
    const warpF = yarnOf(state.warp);
    const weftF = state.weftDifferent ? yarnOf(state.weft) : warpF;
    return {
      mode: state.mode,
      faw_target: parseNum(state.faw),
      warp_share: parseNum(state.share) / 100, // l'utente scrive %, il motore vuole frazioni
      n_warp: parseNum(state.nWarp),
      n_weft: parseNum(state.nWeft),
      faw_meas: optionalNum(state.fawMeas),
      warp: warpF ? { tex: warpF.tex, rho: warpF.density } : null,
      weft: weftF ? { tex: weftF.tex, rho: weftF.density } : null,
      crimp_warp: parseNum(state.crimpWarp) / 100,
      crimp_weft: parseNum(state.crimpWeft) / 100,
      tex_tol: parseNum(state.texTol) / 100,
      vf_yarn: parseNum(state.phi) / 100, // φ: l'utente scrive %, il motore vuole frazioni
      vf_lam: FIXED.vf_lam,
      shape: FIXED.shape,
      weave: state.weave,
      w_meas_warp: null,
      w_meas_weft: null,
      t_native_warp: optionalNum(state.t0Warp),
      // Con lo stesso filato in trama, lo spessore nativo è lo stesso.
      t_native_weft: optionalNum(state.weftDifferent ? state.t0Weft : state.t0Warp),
    };
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
    const p1 = res.warp ? res.warp.pitch : null;
    const p2 = res.weft ? res.weft.pitch : null;
    // Bilanciato con lo stesso filato: un numero solo, stessa informazione.
    $("k-w").textContent =
      p1 !== null && p2 !== null && Math.abs(p1 - p2) < 1e-9 ? fmt(p1, 2) : fmt(p1, 2) + " / " + fmt(p2, 2);
  }

  function renderResultTable(res) {
    const body = $("result-table").querySelector("tbody");
    if (res.error) {
      body.innerHTML = "";
      return;
    }
    const o = res.warp || {};
    const t = res.weft || {};
    const st = res.weave;
    const row = (label, a, b, cls) =>
      `<tr${cls ? ` class="${cls}"` : ""}><th scope="row">${label}</th><td>${a}</td><td>${b}</td></tr>`;
    const floatCell = (mm, n) =>
      mm === null || mm === undefined ? "—" : `${fmt(mm, 1)} <span class="unit">(${n} fili)</span>`;
    let html = "";
    html += row("Fili/cm", fmt(res.warp ? res.n_warp : null, 2), fmt(res.weft ? res.n_weft : null, 2));
    html += row("Fili/pollice", fmt(o.per_inch, 1), fmt(t.per_inch, 1));
    html += row("Passo, mm", fmt(o.pitch, 2), fmt(t.pitch, 2));
    html += row("Sezione di fibra del tow, mm²", fmt(o.af, 3), fmt(t.af, 3));
    html += row("Flottazione più lunga, mm", floatCell(o.float_max_mm, st.float_max_warp), floatCell(t.float_max_mm, st.float_max_weft), "sep");
    html += row("Lunghezza del rapporto, mm", fmt(o.repeat_mm, 1), fmt(t.repeat_mm, 1));
    html += row("Cambi di lato per cm", fmt(o.transitions_cm, 1), fmt(t.transitions_cm, 1));
    body.innerHTML = html;
  }

  function renderFacts(res) {
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
      [`Spessore del ply curato a Vf ${fmt(FIXED.vf_lam * 100, 0)} %`, fmt(res.ply_thickness, 3) + " mm"],
      ["Inserzioni di trama per metro", fmt(res.picks_per_m, 0)],
      ["Fili di ordito per metro di altezza", fmt(res.ends_per_m, 0)],
    ];
    dl.innerHTML = facts.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join("");
  }

  function renderCrimpImplied(res) {
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
      svg.setAttribute("viewBox", "0 0 320 320");
      const msg = el("text", { x: 160, y: 160, "text-anchor": "middle", fill: COLORS.ink2, "font-size": 14, "font-family": FONT });
      msg.textContent = res && !res.error ? "Anteprima disponibile con ordito e trama" : "Anteprima non disponibile";
      svg.appendChild(msg);
      $("weave-caption").textContent = "";
      return;
    }
    const win = viewWindow([res], 2);
    const w = towWidths(res);
    drawFabric(svg, {
      matrix: Calc.weaveMatrix(res.weave.id), pw: res.warp.pitch, pf: res.weft.pitch,
      ww: w.ww, wf: w.wf, win: win, uid: "calc", S: 320,
    });
    const estimated = res.warp.w_tow !== null;
    $("weave-caption").textContent =
      `${Calc.WEAVES[res.weave.id].label}, finestra di ${fmt(win, 1)} mm, ordito in verticale. ` +
      (estimated
        ? "Tow alla larghezza nativa stimata, senza spreading: in ambra i gap."
        : "Tow larghi quanto il passo: inserisci lo spessore nativo per vedere i gap.");
  }

  function diametersText(tMm, fiber) {
    // Spessore espresso in diametri di filamento: dà un'idea di quanti strati
    // di filamenti restano. Serve il numero di filamenti per il diametro.
    if (!fiber || !fiber.filaments || !(tMm > 0)) return "";
    const dMm = Calc.equivalentDiameterUm(fiber.tex, fiber.filaments, fiber.density) / 1000;
    return ` <span class="unit">(≈${fmt(tMm / dMm, 0)} Ø)</span>`;
  }

  function renderSpread(res) {
    const body = $("spread-table").querySelector("tbody");
    const facts = $("hole-facts");
    const note = $("spread-note");
    if (res.error || !res.warp || !res.weft || res.warp.w_tow === null) {
      body.innerHTML = "";
      facts.innerHTML = "";
      note.innerHTML = res.error ? "" : "<p>Inserisci φ e lo spessore nativo per stimare buchi e spreading.</p>";
      return;
    }
    const o = res.warp, t = res.weft;
    const fO = yarnOf(state.warp);
    const fT = state.weftDifferent ? yarnOf(state.weft) : fO;
    const row = (label, a, b) => `<tr><th scope="row">${label}</th><td>${a}</td><td>${b}</td></tr>`;
    const gapCell = (g) => `<span class="${g < 0 ? "neg" : g > 0 ? "gap" : ""}">${fmt(g, 2)}</span>`;
    // s < 1: il tow nativo è più largo del passo; nel tessuto verrà stretto.
    const sCell = (g) => (g.spread_factor <= 1 ? `${fmt(g.spread_factor, 2)} <span class="unit">(nessuno)</span>` : fmt(g.spread_factor, 2));
    body.innerHTML =
      row("Larghezza nativa stimata, mm", fmt(o.w_tow, 2), fmt(t.w_tow, 2)) +
      row("Passo, mm", fmt(o.pitch, 2), fmt(t.pitch, 2)) +
      row("Gap tra tow, mm", gapCell(o.gap), gapCell(t.gap)) +
      row("Fattore di spreading per chiudere, ×", sCell(o), sCell(t)) +
      row("Spessore nativo, mm", fmt(o.t_tow, 3) + diametersText(o.t_tow, fO), fmt(t.t_tow, 3) + diametersText(t.t_tow, fT)) +
      row("Spessore a passo pieno, mm", fmt(o.t_req, 3) + diametersText(o.t_req, fO), fmt(t.t_req, 3) + diametersText(t.t_req, fT));

    const items = [
      ["Buchi passanti per cm²", fmt(res.holes_cm2, 1)],
      ["Dimensione del buco", res.holes_cm2 > 0 ? `${fmt(res.hole_w, 2)} × ${fmt(res.hole_h, 2)} mm` : "—"],
      ["Area aperta", fmt(res.open_area * 100, 1) + " %"],
    ];
    facts.innerHTML = items.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join("");

    // Lettura pratica dei numeri.
    const parts = [];
    if (o.gap <= 0 && t.gap <= 0) {
      parts.push("<p>Con questi valori il tow nativo copre già il passo in entrambe le direzioni: niente buchi. " +
        "Dove è più largo del passo, nel tessuto verrà stretto e diventerà più spesso.</p>");
    } else if (res.holes_cm2 === 0) {
      const open = o.gap > 0 ? "ordito" : "trama";
      parts.push(`<p>Nessun buco passante: una direzione è già chiusa. Tra i fili di ${open} restano però canali ` +
        "senza fibra, che nel laminato diventano zone ricche di resina a metà spessore.</p>");
    } else {
      // Per i buchi passanti basta chiudere UNA direzione: indichiamo quella
      // che richiede meno spreading. Se sono uguali (bilanciato), lo diciamo.
      const same = Math.abs(o.spread_factor - t.spread_factor) < 0.005;
      const first = same
        ? `basta allargare una delle due direzioni di ${fmt(o.spread_factor, 2)}×`
        : o.spread_factor < t.spread_factor
          ? `basta allargare l'ordito di ${fmt(o.spread_factor, 2)}×`
          : `basta allargare la trama di ${fmt(t.spread_factor, 2)}×`;
      parts.push(`<p>Per eliminare i buchi passanti ${first}. Per chiudere anche i canali di resina servono ` +
        `${fmt(o.spread_factor, 2)}× in ordito e ${fmt(t.spread_factor, 2)}× in trama.</p>`);
    }
    parts.push("<p>È il caso peggiore: tensione, pettine e battuta appiattiscono già un po' il tow durante la tessitura.</p>");
    note.innerHTML = parts.join("");
  }

  function recompute() {
    saveState();
    const inp = buildCalcInput();
    const res = Calc.compute(inp);
    showError(res.error);
    if (!res.error) lastResult = res;
    renderKpis(res, inp);
    renderResultTable(res);
    renderFacts(res);
    renderCrimpImplied(res);
    renderSpread(res);
    drawCalc(res);
    if (!res.error) $("weave-note").textContent = weaveNote(res.weave.id, res.weave);
  }

  // ---------------------------------------------------------------------------
  // Vista Confronto (A a sinistra, B a destra)
  // ---------------------------------------------------------------------------
  // Il confronto ha la sua grammatura e il suo crimp, scritti in cima alla
  // vista: niente valori "nascosti" presi da un'altra scheda.

  function computeSide(side) {
    const spec = state.cmp[side];
    const f = yarnOf(spec);
    if (!f) return { error: `Colonna ${side.toUpperCase()}: scegli un filato o inserisci titolo e densità.` };
    const res = Calc.compute({
      mode: "faw", faw_target: parseNum(state.cmp.faw), warp_share: 0.5,
      n_warp: 0, n_weft: 0, faw_meas: null,
      warp: { tex: f.tex, rho: f.density }, weft: { tex: f.tex, rho: f.density },
      crimp_warp: parseNum(state.cmp.crimp) / 100, crimp_weft: parseNum(state.cmp.crimp) / 100,
      tex_tol: 0, vf_yarn: parseNum(state.cmp.phi) / 100, vf_lam: FIXED.vf_lam, shape: FIXED.shape,
      weave: spec.weave, w_meas_warp: null, w_meas_weft: null,
      t_native_warp: optionalNum(spec.t0), t_native_weft: optionalNum(spec.t0),
    });
    return res.error ? { error: res.error } : { fiber: f, res: res };
  }

  // Righe della tabella: un'unica definizione serve schermo, CSV e immagine,
  // così i tre non possono divergere. [etichetta, valore, decimali];
  // decimali null = riga di testo, senza differenza percentuale.
  function compareRows() {
    return [
      ["Armatura", (x) => Calc.WEAVES[x.res.weave.id].short, null],
      ["Titolo, tex", (x) => x.fiber.tex, 0],
      ["Densità, g/cm³", (x) => x.fiber.density, 2],
      ["Diametro equivalente, µm", (x) => (x.fiber.filaments ? Calc.equivalentDiameterUm(x.fiber.tex, x.fiber.filaments, x.fiber.density) : null), 2],
      ["Fili/cm", (x) => x.res.n_warp, 2],
      ["Fili/pollice", (x) => x.res.warp.per_inch, 1],
      ["Passo, mm", (x) => x.res.warp.pitch, 2],
      ["Sezione di fibra del tow, mm²", (x) => x.res.warp.af, 3],
      ["Rapporto, mm", (x) => x.res.warp.repeat_mm, 1],
      ["Flottazione più lunga, mm", (x) => x.res.warp.float_max_mm, 1],
      ["Legature/cm²", (x) => x.res.bindings_cm2, 1],
      ["Indice di intreccio", (x) => x.res.weave.interlacing_warp, 2],
      [`Spessore ply curato a Vf ${fmt(FIXED.vf_lam * 100, 0)} %, mm`, (x) => x.res.ply_thickness, 3],
      ["Inserzioni di trama/m", (x) => x.res.picks_per_m, 0],
      // Buchi e spreading: null se manca lo spessore nativo (la cella mostra "—").
      ["Larghezza nativa stimata, mm", (x) => x.res.warp.w_tow, 2],
      ["Gap tra tow, mm", (x) => x.res.warp.gap, 2],
      ["Fattore di spreading, ×", (x) => x.res.warp.spread_factor, 2],
      ["Buchi passanti/cm²", (x) => x.res.holes_cm2, 1],
      ["Area aperta, %", (x) => (x.res.open_area === null ? null : x.res.open_area * 100), 1],
    ];
  }

  function cellText(v, digits) {
    return digits === null ? String(v) : fmt(v, digits);
  }

  function deltaText(a, b, digits) {
    // Differenza di B rispetto ad A in percentuale: è il numero che risponde
    // alla domanda "quanto cambia se passo da A a B?".
    if (digits === null) return a === b ? "uguale" : "diversa";
    if (!isFinite(a) || !isFinite(b) || a === 0 || a === null || b === null) return "—";
    const pct = ((b - a) / a) * 100;
    if (Math.abs(pct) < 0.5) return "=";
    return (pct > 0 ? "+" : "−") + fmt(Math.abs(pct), 0) + " %";
  }

  function computeCompare() {
    const a = computeSide("a");
    const b = computeSide("b");
    const error = a.error || b.error || null;
    return { error: error, a: Object.assign({ tag: "A" }, a), b: Object.assign({ tag: "B" }, b) };
  }

  function renderCompare() {
    const { error, a, b } = computeCompare();
    const errEl = $("compare-error");
    errEl.textContent = error || "";
    errEl.hidden = !error;
    const grid = $("compare-drawings");
    grid.replaceChildren();
    if (error) {
      $("compare-table").querySelector("thead").innerHTML = "";
      $("compare-table").querySelector("tbody").innerHTML = "";
      $("compare-caption").textContent = "";
      return;
    }

    // Stessa finestra (e quindi stessa scala) per i due disegni.
    const win = viewWindow([a.res, b.res], 1);
    [a, b].forEach((x) => {
      const fig = document.createElement("figure");
      fig.className = "cmp-figure";
      const svg = el("svg", { role: "img", "aria-label": `Tessuto ${x.tag}` });
      const w = towWidths(x.res);
      drawFabric(svg, {
        matrix: Calc.weaveMatrix(x.res.weave.id), pw: x.res.warp.pitch, pf: x.res.weft.pitch,
        ww: w.ww, wf: w.wf, win: win, uid: "cmp" + x.tag, S: 320, barK: 1.7,
      });
      fig.appendChild(svg);
      const cap = document.createElement("figcaption");
      cap.innerHTML = `<b><span class="tag">${x.tag}</span>${escapeHTML(fiberName(x.fiber))}</b>` +
        `<span class="meta">${escapeHTML(Calc.WEAVES[x.res.weave.id].short)}, ${fmt(x.res.n_warp, 2)} fili/cm</span>`;
      fig.appendChild(cap);
      grid.appendChild(fig);
    });
    $("compare-caption").textContent =
      `Entrambi bilanciati a ${fmt(a.res.faw, 0)} g/m², stessa scala, ordito in verticale, ` +
      "tow alla larghezza nativa stimata (in ambra i gap). L'ultima colonna dice di quanto cambia B rispetto ad A.";

    // Nell'intestazione basta la lettera: il nome completo è già sotto il
    // disegno, e ripeterlo qui farebbe andare a capo la colonna su 4 righe.
    const head = (x) => `<th scope="col"><span class="tag" title="${escapeHTML(fullName(x.fiber))}">${x.tag}</span></th>`;
    $("compare-table").querySelector("thead").innerHTML =
      `<tr><th scope="col"></th>${head(a)}${head(b)}<th scope="col">B rispetto ad A</th></tr>`;
    $("compare-table").querySelector("tbody").innerHTML = compareRows()
      .map(([label, get, d]) => {
        const va = get(a), vb = get(b);
        return `<tr><th scope="row">${escapeHTML(label)}</th><td>${escapeHTML(cellText(va, d))}</td>` +
          `<td>${escapeHTML(cellText(vb, d))}</td><td>${escapeHTML(deltaText(va, vb, d))}</td></tr>`;
      })
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
    const { error, a, b } = computeCompare();
    if (error) return;
    // Punto e virgola e virgola decimale: è ciò che Excel in italiano si aspetta.
    // Il BOM iniziale (\uFEFF) dice a Excel che il file è UTF-8 (µ, ², ³).
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [
      q(`Trama, confronto a ${fmt(a.res.faw, 0)} g/m², crimp ${fmt(parseNum(state.cmp.crimp), 1)} %`),
      [q(""), q("A " + fullName(a.fiber)), q("B " + fullName(b.fiber)), q("B rispetto ad A")].join(";"),
    ];
    compareRows().forEach(([label, get, d]) => {
      const va = get(a), vb = get(b);
      lines.push([q(label), q(cellText(va, d)), q(cellText(vb, d)), q(deltaText(va, vb, d))].join(";"));
    });
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv" });
    shareOrDownload(blob, `trama-confronto-${today()}.csv`, $("compare-msg"), "Tabella esportata");
  }

  function buildExportSVG() {
    // Un unico SVG con titolo, i due disegni affiancati e la tabella: poi
    // diventa un PNG. Tutto con attributi espliciti (un'immagine non vede il CSS).
    const { a, b } = computeCompare();
    const W = 1080, M = 40, GAP = 24;
    const cell = (W - 2 * M - GAP) / 2;
    const capH = 70;
    const rows = compareRows();
    const rowH = 36, labelW = 330;
    const colW = (W - 2 * M - labelW) / 3;
    const top = 130;
    const tableTop = top + cell + capH + GAP;
    const H = tableTop + (rows.length + 1) * rowH + M;

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
    text(M, 62, `Trama, confronto a ${fmt(a.res.faw, 0)} g/m²`, 34, 700);
    text(M, 100, `Bilanciati, crimp ${fmt(parseNum(state.cmp.crimp), 1)} %, φ ${fmt(parseNum(state.cmp.phi), 0)} %. ` +
      "Stessa scala, ordito in verticale, gap in ambra.", 20, 400, COLORS.ink2);

    const win = viewWindow([a.res, b.res], 1);
    [a, b].forEach((x, k) => {
      const cx = M + k * (cell + GAP);
      const svg = el("svg", { x: cx, y: top, width: cell, height: cell });
      const w = towWidths(x.res);
      drawFabric(svg, {
        matrix: Calc.weaveMatrix(x.res.weave.id), pw: x.res.warp.pitch, pf: x.res.weft.pitch,
        ww: w.ww, wf: w.wf, win: win, uid: "exp" + x.tag, S: cell,
      });
      root.appendChild(svg);
      root.appendChild(el("rect", { x: cx, y: top, width: cell, height: cell, fill: "none", stroke: COLORS.line, "stroke-width": 1 }));
      text(cx, top + cell + 32, `${x.tag}  ${fullName(x.fiber)}`, 24, 600);
      text(cx, top + cell + 58, `${Calc.WEAVES[x.res.weave.id].label}, ${fmt(x.res.n_warp, 2)} fili/cm, passo ${fmt(x.res.warp.pitch, 2)} mm`, 19, 400, COLORS.ink2);
    });

    // Tabella a righe alterne: guidano l'occhio lungo la riga.
    root.appendChild(el("rect", { x: M, y: tableTop, width: W - 2 * M, height: rowH, fill: "#FFFFFF" }));
    ["A", "B", "B rispetto ad A"].forEach((h, k) => text(M + labelW + (k + 1) * colW - 12, tableTop + 24, h, 18, 600, COLORS.ink, "end"));
    rows.forEach(([label, get, d], r) => {
      const y = tableTop + (r + 1) * rowH;
      const va = get(a), vb = get(b);
      root.appendChild(el("rect", { x: M, y: y, width: W - 2 * M, height: rowH, fill: r % 2 ? "#FFFFFF" : "#ECEFF1" }));
      text(M + 12, y + 24, label, 18, 400, COLORS.ink2);
      [cellText(va, d), cellText(vb, d), deltaText(va, vb, d)].forEach((v, k) =>
        text(M + labelW + (k + 1) * colW - 12, y + 24, v, 18, k === 2 ? 600 : 500, COLORS.ink, "end"));
    });
    return root;
  }

  function exportPNG() {
    const msg = $("compare-msg");
    if (computeCompare().error) return;
    const svg = buildExportSVG();
    const W = Number(svg.getAttribute("width"));
    const H = Number(svg.getAttribute("height"));
    const str = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([str], { type: "image/svg+xml" });
    const fallback = () => shareOrDownload(svgBlob, `trama-confronto-${today()}.svg`, msg, "PNG non disponibile, esportato in SVG");
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
          else fallback();
        }, "image/png");
      } catch (e) {
        // Alcuni browser vietano di esportare un canvas su cui è stato
        // disegnato un SVG: in quel caso consegniamo l'SVG, apribile ovunque.
        fallback();
      }
    };
    img.onerror = fallback;
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(str);
  }

  // ---------------------------------------------------------------------------
  // Vista Filati
  // ---------------------------------------------------------------------------

  function renderDbStatus() {
    // Conteggio sui soli filati ufficiali: i fornitori dei filati personali
    // non devono gonfiare il numero.
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
          `<button type="button" class="btn btn-small" data-act="cmp" data-id="${escapeHTML(f.id)}">In B</button>` +
          `</div>`).join("") +
        `</div></div>`;
    }).join("");
    $("db-list").innerHTML = html || '<p class="hint">Nessun filato trovato. Aggiungilo qui sotto, oppure usa «Valori a mano» nel Calcolo.</p>';
  }

  function normalizeRecord(r) {
    // Porta un record (modulo, valori a mano o file importato) alla forma
    // attesa, o restituisce null se manca qualcosa di essenziale.
    const num = (x) => (typeof x === "number" ? x : parseNum(x));
    const fil = typeof r.filaments === "number" ? Math.round(r.filaments) : parseFilaments(r.filaments);
    const rec = {
      supplier: String(r.supplier || "").trim(),
      grade: String(r.grade || "").trim(),
      filaments: fil,
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
    // Il database è cambiato: tutti i menu dei filati vanno ricostruiti.
    renderAllPickers();
    renderDbStatus();
    renderDbList();
    recompute();
    renderCompare();
  }

  async function exportDatabase() {
    // Database ufficiale + filati personali, nello stesso formato di
    // fibers.json: si rimette nel repo o si importa su un altro iPhone.
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
  // Navigazione ed eventi
  // ---------------------------------------------------------------------------

  const SUBTITLES = {
    calc: "Grammatura, fili/cm e armatura di tessuti in fibra di carbonio",
    compare: "Due filati a confronto, A a sinistra e B a destra",
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
    saveState();
    window.scrollTo(0, 0);
  }

  function bindText(id, get, set, after) {
    const input = $(id);
    input.value = get();
    input.addEventListener("input", () => {
      set(input.value);
      after();
    });
  }

  function syncT0Rows() {
    // Con trama uguale all'ordito basta uno spessore; con trama diversa, due.
    $("t0-weft-row").hidden = !state.weftDifferent;
    $("t0-warp-label").textContent = state.weftDifferent ? "Spessore nativo, ordito" : "Spessore nativo del tow";
  }

  function syncModeVisibility() {
    $("faw-inputs").hidden = state.mode !== "faw";
    $("density-inputs").hidden = state.mode !== "density";
  }

  function bindEvents() {
    // --- Calcolo ---
    [
      ["faw", "faw"], ["share", "share"], ["n-warp", "nWarp"], ["n-weft", "nWeft"], ["faw-meas", "fawMeas"],
      ["crimp-warp", "crimpWarp"], ["crimp-weft", "crimpWeft"], ["tex-tol", "texTol"],
      ["phi", "phi"], ["t0-warp", "t0Warp"], ["t0-weft", "t0Weft"],
    ].forEach(([id, key]) => bindText(id, () => state[key], (v) => { state[key] = v; }, recompute));
    syncT0Rows();

    $("weave-picker").addEventListener("click", (e) => {
      const b = e.target.closest("[data-weave]");
      if (!b) return;
      state.weave = b.dataset.weave;
      document.querySelectorAll(".weave-chip").forEach((c) =>
        c.setAttribute("aria-checked", String(c.dataset.weave === state.weave)));
      recompute();
    });

    $("weft-different").checked = state.weftDifferent;
    $("weft-block").hidden = !state.weftDifferent;
    $("weft-different").addEventListener("change", (e) => {
      state.weftDifferent = e.target.checked;
      // Si parte da una copia dell'ordito: il risultato non salta finché
      // l'utente non sceglie qualcos'altro.
      if (state.weftDifferent) {
        state.weft = clone(state.warp);
        renderPicker("weft");
      }
      $("weft-block").hidden = !state.weftDifferent;
      if (state.weftDifferent) {
        state.t0Weft = state.t0Warp; // la trama parte dallo stesso spessore dell'ordito
        $("t0-weft").value = state.t0Weft;
      }
      syncT0Rows();
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
    bindText("cmp-faw", () => state.cmp.faw, (v) => { state.cmp.faw = v; }, () => { saveState(); renderCompare(); });
    bindText("cmp-crimp", () => state.cmp.crimp, (v) => { state.cmp.crimp = v; }, () => { saveState(); renderCompare(); });
    bindText("cmp-phi", () => state.cmp.phi, (v) => { state.cmp.phi = v; }, () => { saveState(); renderCompare(); });
    ["a", "b"].forEach((side) => {
      bindText("cmp-t0-" + side, () => state.cmp[side].t0, (v) => { state.cmp[side].t0 = v; }, () => { saveState(); renderCompare(); });
      const sel = $("cmp-weave-" + side);
      sel.innerHTML = weaveOptions(state.cmp[side].weave);
      sel.addEventListener("change", (e) => {
        state.cmp[side].weave = e.target.value;
        saveState();
        renderCompare();
      });
    });
    $("export-png").addEventListener("click", exportPNG);
    $("export-csv").addEventListener("click", exportCSV);

    // --- Filati ---
    $("db-search").value = state.dbQuery;
    $("db-search").addEventListener("input", (e) => {
      state.dbQuery = e.target.value;
      saveState();
      renderDbList();
    });
    $("db-list").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.act === "calc") {
        state.warp.id = id;
        if (!state.weftDifferent) state.weft.id = id;
        renderPicker("warp");
        recompute();
        setView("calc");
      } else {
        // "In B": il filato va nella colonna di destra, A resta com'è.
        state.cmp.b.id = id;
        renderPicker("cmpB");
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
        filaments: $("add-k").value, // "12", "12K" o "12000": ci pensa parseFilaments
        tex: $("add-tex").value,
        density: $("add-rho").value,
        filament_diameter_um: $("add-d").value,
      });
      msg.classList.remove("bad");
      if (!rec) {
        msg.textContent = "Servono fornitore, grado, filamenti (es. 12K), tex e una densità tra 1,6 e 2,25 g/cm³.";
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
      msg.textContent = `Filato aggiunto: ${rec.supplier} ${fiberName(rec)}.` + extra;
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
    registerPicker("warp", $("warp-picker"), () => state.warp, () => {
      // Con trama uguale all'ordito, la trama segue l'ordito.
      if (!state.weftDifferent) state.weft = clone(state.warp);
      recompute();
    });
    registerPicker("weft", $("weft-picker"), () => state.weft, recompute);
    registerPicker("cmpA", $("cmp-picker-a"), () => state.cmp.a, () => { saveState(); renderCompare(); }, true);
    registerPicker("cmpB", $("cmp-picker-b"), () => state.cmp.b, () => { saveState(); renderCompare(); }, true);
    renderAllPickers();
    renderWeavePicker();
    syncModeVisibility();
    bindEvents();
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
