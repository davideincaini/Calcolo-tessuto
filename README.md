# Trama v2

PWA per progettare e confrontare tessuti in fibra di carbonio: dalla grammatura ai fili/cm e viceversa, con l'armatura (plain, twill 2×2, twill 4×4, satin 4H crowfoot, 5H, 8H) disegnata in scala. Confronta fino a 4 tessuti affiancati e ha un database di 103 filati di 9 fornitori, più i tuoi. Funziona offline su iPhone dopo la prima apertura.

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

- **Al posto della v1, nello stesso repository.** Sostituisci il contenuto e fai push. Il service worker ha un nome di cache nuovo (`trama-v2-1`), quindi gli iPhone scaricano la versione nuova al primo avvio online. I filati personali inseriti nella v1 restano.
- **In un repository nuovo**, accanto alla v1. Le due app vivono sullo stesso dominio `utente.github.io`, quindi condividono i filati personali (stessa chiave di memoria). Lo stato del calcolo invece è separato.

La v1 aveva un difetto nel service worker: all'attivazione cancellava tutte le cache del dominio, comprese quelle delle altre PWA pubblicate sotto lo stesso utente GitHub. La v2 cancella solo le cache che iniziano con `trama-`.

## Pubblicare su GitHub Pages

1. Carica il contenuto di questa cartella in un repository (pubblico, o privato se il tuo piano consente Pages sui privati).
2. Settings → Pages → Build and deployment → Source: *Deploy from a branch* → Branch: `main`, cartella `/docs` → Save.
3. Dopo circa un minuto l'app è su `https://<utente>.github.io/<repo>/`.

## Installare su iPhone

1. Apri l'indirizzo in **Safari**.
2. Condividi → *Aggiungi alla schermata Home*.
3. Apri l'app una volta con la connessione attiva: da quel momento funziona anche offline.

I filati personali restano sul telefono (localStorage). iOS può cancellare i dati dei siti in alcune condizioni: usa *Esporta database* per tenerne una copia, e *Importa JSON* per passarli a un collega.

## Aggiornare il database

```bash
pip install -r python/requirements.txt
python python/fiber_db_editor.py      # modifica, spunta "verificato", salva
python -m pytest python -v            # controlla che tutto sia coerente
git commit -am "Database: verificati T700S" && git push
```

La PWA scarica `fibers.json` dalla rete a ogni avvio online, quindi per il database non serve altro.

Se modifichi `index.html`, `app.js`, `calc.js` o `styles.css`, incrementa `CACHE_VERSION` in `docs/sw.js` (`trama-v2-1` → `trama-v2-2`), altrimenti gli iPhone continuano a usare la copia in cache.

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

Armatura, dalla matrice del rapporto (1 = ordito sopra):
- Indice di intreccio = cambi di lato per incrocio. Plain 1; twill 2×2 e 4H 0,5; 5H 0,4; twill 4×4 e 8H 0,25.
- Legature/cm² = (cambi di lato dell'ordito nel rapporto / 2) / (R_o · R_t) · n_o · n_t. Per i satin a R fili vale n²/R.
- Flottazione più lunga in mm = flottazione in fili × passo dell'altra direzione.

## Limiti

- **Il crimp è un dato d'ingresso, non una stima.** L'armatura cambia i fili/cm solo attraverso il crimp. Un modello geometrico semplice (Peirce, filo sinusoidale) dà crimp dell'ordine dello 0,1 % per tessuti di carbonio piatti, un valore che non mi fido a mostrare. Misuralo con il calcolo inverso: fili/cm contati e grammatura pesata.
- **Nessun record del database è verificato.** Diverse fonti sono revisioni datate. Alcune voci nuove hanno una nota da verificare: T830H, la serie TC35 (Formosa) e H2550 12K (Hyosung).
- **La larghezza del tow senza spreading non si calcola**: va misurata nelle condizioni di lavoro. Il disegno usa quella misurata se c'è, altrimenti quella richiesta, che per costruzione copre tutto.
- **Il disegno è una vista in pianta.** Non mostra l'ondulazione del filo, la compressione nelle legature, lo spreading o la distorsione del tessuto.
- **Il confronto usa la base della scheda Calcolo**: stessa grammatura, crimp e Vf per tutti i tessuti. A parità di crimp non si confrontano armature diverse in modo del tutto equo, perché nella realtà il crimp cambia con l'armatura.
- **Mai provato**: l'editor tkinter (tkinter non disponibile nell'ambiente di sviluppo) e la condivisione PNG/CSV su Safari iOS (provata solo in Chromium).
