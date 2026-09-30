"""
fiber_db_editor.py — editor locale del database dei filati (docs/fibers.json).

Avvio (dalla radice del repo):   python python/fiber_db_editor.py

Perché un editor in Python e non modificare il JSON a mano?
    - Ogni record viene validato PRIMA del salvataggio (stesse regole dei test):
      un errore di battitura non arriva mai sull'iPhone.
    - Per ogni filato vedi subito lo scostamento tra tex dichiarato e tex
      ricavato dal diametro: il modo più rapido per scoprire dati sospetti.
    - Il file viene riscritto ordinato: su GitHub il diff mostra solo ciò che
      hai cambiato davvero.

Flusso tipico: apri la scheda tecnica attuale → confronta → correggi →
spunta "verificato" → Salva → commit e push. Al successivo avvio online la
PWA scarica il nuovo database da sola.

Architettura: la finestra è solo uno strato sopra db_tools.py (logica pura,
testata con pytest). Qui c'è il "come si mostra", non il "cosa è valido".
"""

from __future__ import annotations

import tkinter as tk
from tkinter import messagebox, ttk

import db_tools

# Tema Sun Valley chiaro (pip install sv-ttk). Se manca, l'editor funziona lo
# stesso con il tema di sistema: una dipendenza estetica non deve impedire di
# lavorare sui dati.
try:
    import sv_ttk
except ImportError:  # pragma: no cover - dipende dall'ambiente
    sv_ttk = None


def parse_float(text: str) -> float | None:
    """Accetta sia la virgola sia il punto. Stringa vuota → None."""
    t = text.strip().replace(",", ".")
    if not t:
        return None
    return float(t)  # lascia sollevare ValueError: lo gestisce chi chiama


class FiberEditor(tk.Tk):
    # Campi del modulo: (chiave nel JSON, etichetta, convertitore).
    # Un'unica tabella guida sia la costruzione del modulo sia la lettura dei
    # valori: aggiungere un campo significa aggiungere una riga qui.
    FORM_FIELDS = [
        ("supplier", "Fornitore", str),
        ("grade", "Grado", str),
        ("filaments", "Filamenti (numero, es. 12000)", "int"),
        ("tex", "Titolo [tex]", "float"),
        ("density", "Densità [g/cm³]", "float"),
        ("filament_diameter_um", "Diametro filamento [µm] (facoltativo)", "optfloat"),
        ("tensile_strength_mpa", "Resistenza [MPa] (facoltativa)", "optfloat"),
        ("tensile_modulus_gpa", "Modulo [GPa] (facoltativo)", "optfloat"),
        ("source", "Fonte (documento e revisione)", str),
        ("notes", "Note", str),
    ]

    def __init__(self):
        super().__init__()
        self.title("Trama — database dei filati")
        self.geometry("1080x640")
        self.minsize(900, 520)
        if sv_ttk:
            sv_ttk.set_theme("light")

        self.db = db_tools.load_db()
        self.dirty = False                      # modifiche non ancora salvate
        self.current_index: int | None = None   # indice del record in modifica

        self._build_ui()
        self._refresh_tree()
        # Conferma alla chiusura se ci sono modifiche non salvate.
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ UI --

    def _build_ui(self):
        # Due colonne: elenco a sinistra (si allarga), modulo a destra.
        self.columnconfigure(0, weight=3)
        self.columnconfigure(1, weight=2)
        self.rowconfigure(0, weight=1)

        left = ttk.Frame(self, padding=(12, 12, 6, 6))
        left.grid(row=0, column=0, sticky="nsew")
        left.rowconfigure(1, weight=1)
        left.columnconfigure(0, weight=1)

        # Filtro di ricerca: con 100+ record scorrere a mano è lento.
        self.search_var = tk.StringVar()
        self.search_var.trace_add("write", lambda *_: self._refresh_tree())
        ttk.Entry(left, textvariable=self.search_var).grid(row=0, column=0, sticky="ew", pady=(0, 8))

        cols = ("k", "tex", "rho", "d", "dev", "ok")
        self.tree = ttk.Treeview(left, columns=cols, show="tree headings", selectmode="browse")
        headings = {"k": "K", "tex": "tex", "rho": "ρ", "d": "d µm", "dev": "Δ tex da d", "ok": "verificato"}
        self.tree.heading("#0", text="Fornitore / grado")
        self.tree.column("#0", width=200)
        for c in cols:
            self.tree.heading(c, text=headings[c])
            self.tree.column(c, width=80, anchor="e")
        self.tree.grid(row=1, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(left, orient="vertical", command=self.tree.yview)
        scroll.grid(row=1, column=1, sticky="ns")
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.bind("<<TreeviewSelect>>", self._on_select)
        # Righe con scostamento sopra soglia in rosso mattone.
        self.tree.tag_configure("warn", foreground="#9E3A2B")

        right = ttk.Frame(self, padding=(6, 12, 12, 6))
        right.grid(row=0, column=1, sticky="nsew")
        right.columnconfigure(1, weight=1)

        self.vars: dict[str, tk.StringVar] = {}
        for r, (key, label, _) in enumerate(self.FORM_FIELDS):
            ttk.Label(right, text=label).grid(row=r, column=0, sticky="w", pady=3, padx=(0, 8))
            var = tk.StringVar()
            ttk.Entry(right, textvariable=var).grid(row=r, column=1, sticky="ew", pady=3)
            self.vars[key] = var

        r = len(self.FORM_FIELDS)
        self.verified_var = tk.BooleanVar()
        ttk.Checkbutton(right, text="Verificato sulla scheda tecnica attuale",
                        variable=self.verified_var).grid(row=r, column=0, columnspan=2, sticky="w", pady=(8, 4))

        # Riga informativa: coerenza geometrica del record selezionato.
        self.info_var = tk.StringVar()
        ttk.Label(right, textvariable=self.info_var, wraplength=380, foreground="#5B636B").grid(
            row=r + 1, column=0, columnspan=2, sticky="w", pady=(4, 10))

        buttons = ttk.Frame(right)
        buttons.grid(row=r + 2, column=0, columnspan=2, sticky="ew")
        ttk.Button(buttons, text="Nuovo", command=self._new).pack(side="left", padx=(0, 6))
        ttk.Button(buttons, text="Applica modifiche", command=self._apply,
                   style="Accent.TButton" if sv_ttk else "TButton").pack(side="left", padx=6)
        ttk.Button(buttons, text="Elimina", command=self._delete).pack(side="left", padx=6)

        file_buttons = ttk.Frame(right)
        file_buttons.grid(row=r + 3, column=0, columnspan=2, sticky="ew", pady=(14, 0))
        ttk.Button(file_buttons, text="Salva su file", command=self._save).pack(side="left", padx=(0, 6))
        ttk.Button(file_buttons, text="Ricarica da file", command=self._reload).pack(side="left", padx=6)

        self.status_var = tk.StringVar()
        ttk.Label(self, textvariable=self.status_var, padding=(12, 4)).grid(
            row=1, column=0, columnspan=2, sticky="ew")

    # -------------------------------------------------------------- elenco --

    def _refresh_tree(self):
        """Ricostruisce l'albero: fornitori come nodi, filati come figli."""
        self.tree.delete(*self.tree.get_children())
        query = self.search_var.get().strip().lower()
        parents: dict[str, str] = {}
        n_warn = 0
        for i, rec in enumerate(self.db["fibers"]):
            if query and query not in f"{rec['supplier']} {rec['grade']}".lower():
                continue
            sup = rec["supplier"]
            if sup not in parents:
                parents[sup] = self.tree.insert("", "end", text=sup, open=True)
            c = db_tools.consistency(rec)
            dev = "—" if c["deviation"] is None else f"{c['deviation']:+.1%}"
            n_warn += bool(c["warn"])
            d = rec.get("filament_diameter_um")
            # iid = indice nella lista: collega la riga al record senza cercarlo.
            self.tree.insert(
                parents[sup], "end", iid=str(i), text=rec["grade"], tags=("warn",) if c["warn"] else (),
                values=(f"{rec['filaments'] / 1000:g}K", f"{rec['tex']:g}", f"{rec['density']:.2f}",
                        "—" if d is None else f"{d:g}", dev, "sì" if rec.get("verified") else "no"),
            )
        verified = sum(1 for r in self.db["fibers"] if r.get("verified"))
        self._status(f"{len(self.db['fibers'])} filati, {verified} verificati, "
                     f"{n_warn} con Δ tex oltre {db_tools.CONSISTENCY_WARN:.0%}"
                     + ("  •  modifiche non salvate" if self.dirty else ""))

    def _on_select(self, _event=None):
        sel = self.tree.selection()
        if not sel or not sel[0].isdigit():  # clic su un fornitore, non su un filato
            return
        self.current_index = int(sel[0])
        rec = self.db["fibers"][self.current_index]
        for key, _, _ in self.FORM_FIELDS:
            value = rec.get(key)
            self.vars[key].set("" if value is None else str(value))
        self.verified_var.set(bool(rec.get("verified")))
        c = db_tools.consistency(rec)
        msg = f"Diametro equivalente da tex: {c['d_equivalent_um']:.2f} µm."
        if c["deviation"] is not None:
            msg += f" Il tex ricavato dal diametro in scheda differisce del {c['deviation']:+.1%}."
        self.info_var.set(msg)

    # -------------------------------------------------------------- azioni --

    def _read_form(self) -> dict:
        """Converte il modulo in un record. Solleva ValueError con un messaggio chiaro."""
        rec = {}
        for key, label, kind in self.FORM_FIELDS:
            raw = self.vars[key].get()
            try:
                if kind is str:
                    rec[key] = raw.strip()
                elif kind == "int":
                    rec[key] = int(round(parse_float(raw)))
                elif kind == "float":
                    value = parse_float(raw)
                    if value is None:
                        raise ValueError
                    rec[key] = value
                else:  # "optfloat"
                    rec[key] = parse_float(raw)
            except (ValueError, TypeError):
                raise ValueError(f"Valore non valido in «{label}»") from None
        rec["verified"] = bool(self.verified_var.get())
        return rec

    def _new(self):
        self.tree.selection_remove(self.tree.selection())
        self.current_index = None
        for var in self.vars.values():
            var.set("")
        self.verified_var.set(False)
        self.info_var.set("Nuovo filato: compila i campi e premi «Applica modifiche».")

    def _apply(self):
        try:
            rec = self._read_form()
        except ValueError as e:
            messagebox.showerror("Dato non valido", str(e))
            return
        errors = db_tools.validate_record(rec)
        if errors:
            messagebox.showerror("Record non valido", "\n".join(errors))
            return
        # Doppioni: stesso fornitore/grado/filamenti in un ALTRO record.
        key = db_tools.record_key(rec)
        for i, other in enumerate(self.db["fibers"]):
            if i != self.current_index and db_tools.record_key(other) == key:
                messagebox.showerror("Doppione", "Esiste già un filato con stesso fornitore, grado e filamenti.")
                return
        if self.current_index is None:
            self.db["fibers"].append(rec)
            self.current_index = len(self.db["fibers"]) - 1
        else:
            self.db["fibers"][self.current_index] = rec
        self.dirty = True
        self._refresh_tree()
        self.tree.selection_set(str(self.current_index))
        self.tree.see(str(self.current_index))

    def _delete(self):
        if self.current_index is None:
            return
        rec = self.db["fibers"][self.current_index]
        if not messagebox.askyesno("Elimina", f"Eliminare {rec['supplier']} {rec['grade']} "
                                              f"{rec['filaments'] / 1000:g}K?"):
            return
        del self.db["fibers"][self.current_index]
        self.current_index = None
        self.dirty = True
        self._new()
        self._refresh_tree()

    def _save(self):
        problems = db_tools.validate_db(self.db)
        if problems:
            # Non salviamo un database che i test farebbero fallire.
            messagebox.showerror("Impossibile salvare", "\n".join(problems[:15]))
            return
        db_tools.save_db(self.db)
        # Dopo il salvataggio il file è riordinato: ricarichiamo per riallineare gli indici.
        self.db = db_tools.load_db()
        self.dirty = False
        self.current_index = None
        self._refresh_tree()
        self._status(f"Salvato in {db_tools.DEFAULT_DB_PATH}. Ricorda commit e push su GitHub.")

    def _reload(self):
        if self.dirty and not messagebox.askyesno("Ricarica", "Scartare le modifiche non salvate?"):
            return
        self.db = db_tools.load_db()
        self.dirty = False
        self._new()
        self._refresh_tree()

    def _status(self, text: str):
        self.status_var.set(text)

    def _on_close(self):
        if self.dirty and not messagebox.askyesno("Esci", "Ci sono modifiche non salvate. Uscire comunque?"):
            return
        self.destroy()


if __name__ == "__main__":
    FiberEditor().mainloop()
