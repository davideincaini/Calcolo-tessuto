# Trama v2

PWA per progettare e confrontare tessuti in fibra di carbonio: dalla grammatura ai fili/cm e viceversa, con l'armatura (plain, twill 2×2, twill 4×4, satin 4H crowfoot, 5H, 8H) disegnata in scala. Confronta due filati affiancati, A a sinistra e B a destra, con la differenza percentuale riga per riga. Ha un database di 103 filati di 9 fornitori; un filato che non c'è si inserisce a mano (tex, densità, filamenti) direttamente dove lo scegli, e volendo si salva tra i filati personali. Funziona offline su iPhone dopo la prima apertura.

## Struttura

```
docs/                    ← la PWA (servita da GitHub Pages)
  index.html, styles.css
  calc.js                ← tutte le formule e le armature, nessuna interfaccia
  app.js                 ← interfaccia: legge i campi, chiama calc.js, disegna
  fibers.json            ← database dei filati (unica fonte di verità)
  sw.js, manifest.webmanifest, icons/
python/
  calc_reference.py      ← stesse formule di calc.js, in Python (usabile nei notebook)
  db_tools.py            ← carica, valida e controlla la coerenza del database
  fiber_db_editor.py     ← editor tkinter del database
  test_calc.py           ← test, incluso il confronto JS ↔ Python
```

## Rapporto con Trama v1

Stessa struttura e stesso formato del database. Due modi di pubblicarla:

- **Al posto della v1, nello stesso repository.** Sostituisci il contenuto e fai push. Il service worker ha un nome di cache nuovo (`trama-v2-3`), quindi gli iPhone scaricano la versione nuova al primo avvio online. I filati personali inseriti nella v1 restano.
- **In un repository nuovo**, accanto alla v1. Nel browser le due app condividono i filati personali, perché vivono sullo stesso dominio `utente.github.io` e usano la stessa chiave di memoria. Sull'iPhone invece ogni app aggiunta alla schermata Home ha una memoria propria: per portare i filati dall'una all'altra usa *Esporta database* e *Importa JSON*.

La v1 aveva un difetto nel service worker: all'attivazione cancellava tutte le cache del dominio, comprese quelle delle altre PWA pubblicate sotto lo stesso utente GitHub. La v2 cancella solo le cache che iniziano con `trama-`.

## Pubblicare su GitHub Pages

1. Carica il contenuto di questa cartella in un repository (pubblico, o privato se il tuo piano consente Pages sui privati).
2. Settings → Pages → Build and deployment → Source: *Deploy from a branch* → Branch: `main`, cartella `/docs` → Save.
3. Dopo circa un minuto l'app è su `https://<utente>.github.io/<repo>/`.

## Installare su iPhone

1. Apri l'indirizzo in **Safari**.
2. Condividi → *Aggiungi alla schermata Home*.
3. Apri l'app una volta con la connessione attiva: da quel momento funziona anche offline.

Dopo un aggiornamento del repository, apri l'app con la connessione attiva, chiudila dal selettore delle app e riaprila: la prima apertura scarica la versione nuova, la seconda la mostra. L'icona sulla schermata Home invece resta quella vecchia finché non rimuovi e riaggiungi l'app, e rimuoverla cancella i filati personali: esportali prima.

I filati personali restano sul telefono (localStorage). iOS può cancellare i dati dei siti in alcune condizioni: usa *Esporta database* per tenerne una copia, e *Importa JSON* per passarli a un collega.

## Aggiornare il database

```bash
pip install -r python/requirements.txt
python python/fiber_db_editor.py      # modifica, spunta "verificato", salva
python -m pytest python -v            # controlla che tutto sia coerente
git commit -am "Database: verificati T700S" && git push
```

La PWA scarica `fibers.json` dalla rete a ogni avvio online, quindi per il database non serve altro.

Se modifichi `index.html`, `app.js`, `calc.js` o `styles.css`, incrementa `CACHE_VERSION` in `docs/sw.js` (es. `trama-v2-3` → `trama-v2-4`), altrimenti gli iPhone continuano a usare la copia in cache.

## Test

```bash
python -m pytest python -v
```

`test_js_uguale_a_python` esegue `docs/calc.js` con Node.js su 400 ingressi casuali, tutte le armature comprese, e confronta i risultati con `calc_reference.py`. Senza Node installato viene saltato.

## Formule, in breve

Tessuto:
- Grammatura per direzione: `FAW_dir = n · T · (1 + c) / 10`, con n in fili/cm, T in tex, c crimp.
- Bilanciato, stesso filato: `n = 5 · FAW / (T · (1 + c))`.
- Crimp implicito da grammatura misurata: `c = 10 · FAW_mis / (n_o·T_o + n_t·T_t) − 1`.
- Area di fibra nel filo: `A_f = T / (1000 · ρ)` in mm². Larghezza richiesta = passo = `10 / n` mm.
- Spessore del ply curato: `t = Σ(FAW_k / ρ_k) / (1000 · Vf)` in mm.

Buchi e spreading:
- Larghezza nativa del tow: `w₀ = A_f / (φ · k · t₀)`, da `A_tow = A_f/φ = k·w·t`. Sezione rettangolare (k = 1): t₀ è lo spessore medio equivalente.
- Gap: `g = p − w₀`. Fattore di spreading per chiudere: `s = p / w₀ = t₀ / t_req`.
- Buchi passanti dove i gap delle due direzioni si incrociano: `n_o · n_t` per cm², di `g_o × g_t` mm; area aperta `(1 − w_o/p_o)(1 − w_t/p_t)`.
- Conseguenza del modello a t₀ fisso: `s = 2000 · ρ · φ · (1 + c) · t₀ / FAW`, senza il tex. A parità di grammatura filati di titolo diverso richiedono lo stesso spreading; cambiano dimensione e numero dei buchi, non l'area aperta.

Armatura, dalla matrice del rapporto (1 = ordito sopra):
- Indice di intreccio = cambi di lato per incrocio. Plain 1; twill 2×2 e 4H 0,5; 5H 0,4; twill 4×4 e 8H 0,25.
- Legature/cm² = (cambi di lato dell'ordito nel rapporto / 2) / (R_o · R_t) · n_o · n_t. Per i satin a R fili vale n²/R.
- Flottazione più lunga in mm = flottazione in fili × passo dell'altra direzione.

## Limiti

- **Il crimp è un dato d'ingresso, non una stima.** L'armatura cambia i fili/cm solo attraverso il crimp. Un modello geometrico semplice (Peirce, filo sinusoidale) dà crimp dell'ordine dello 0,1 % per tessuti di carbonio piatti, un valore che non mi fido a mostrare. Misuralo con il calcolo inverso: fili/cm contati e grammatura pesata.
- **Nessun record del database è verificato.** Diverse fonti sono revisioni datate. Alcune voci nuove hanno una nota da verificare: T830H, la serie TC35 (Formosa) e H2550 12K (Hyosung).
- **La larghezza nativa è stimata, non misurata.** Dipende dal prodotto φ·t₀. Il valore predefinito t₀ = 0,11 mm con φ = 80 % rende largo circa 5 mm un 12K da 800 tex, la larghezza di un tow 12K convenzionale riportata da El-Dessouky e Lawrence; per 3K e 6K non è verificato. Il motore accetta anche una larghezza misurata (`w_meas_warp`, `w_meas_weft`), che vince sulla stima, ma l'interfaccia non la chiede.
- **I buchi calcolati sono il caso peggiore**: la tessitura appiattisce già un po' il tow, e lo spostamento dei fili nel tessuto non è modellato.
- **Parametri fissi**: sezione rettangolare e Vf del laminato 0,55 (costante `FIXED` in `app.js`). Il Vf del laminato influenza solo lo spessore del ply, e l'etichetta lo dichiara.
- **Il disegno è una vista in pianta.** Non mostra l'ondulazione del filo, la compressione nelle legature, lo spreading o la distorsione del tessuto.
- **Il confronto usa un crimp unico per A e B**, scritto in cima alla vista. Con armature diverse il confronto non è del tutto equo, perché nella realtà il crimp cambia con l'armatura.
- **Mai provato**: l'editor tkinter (tkinter non disponibile nell'ambiente di sviluppo), la condivisione PNG/CSV su Safari iOS e la finestra che chiede il nome quando salvi un filato inserito a mano (provate solo in Chromium).
