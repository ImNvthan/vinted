import { useState, useEffect, useCallback, useRef } from "react";

const GMAIL_MCP = { type: "url", url: "https://gmailmcp.googleapis.com/mcp/v1", name: "gmail-mcp" };

// ── Fuzzy matching ────────────────────────────────────────────────────────
function normalize(s) { return s.toLowerCase().replace(/['']/g, "'").trim(); }

function matchCatalogue(emailTitle, catalogue) {
  const t = normalize(emailTitle);
  const STOP = new Set(["de","le","la","les","du","des","un","une","au","aux","et","en","à","the","for","with"]);
  for (const item of catalogue)
    if (normalize(item.name) === t) return { item, score: 1.0 };
  for (const item of catalogue) {
    const n = normalize(item.name);
    if (t.includes(n) || n.includes(t)) return { item, score: 0.85 };
  }
  const tW = new Set(t.split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
  let best = { item: null, score: 0 };
  for (const item of catalogue) {
    const iW = new Set(normalize(item.name).split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
    const inter = [...tW].filter(w => iW.has(w)).length;
    const union = new Set([...tW, ...iW]).size;
    const score = union ? inter / union : 0;
    if (score > best.score) best = { item, score };
  }
  return best.score >= 0.25 ? best : { item: null, score: 0 };
}

// ── Parse CSV line ────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const sep = line.includes(";") ? ";" : ",";
  const parts = []; let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === sep && !inQ) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

const fmt = (iso) => {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
};
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// ══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab, setTab] = useState("surveillance");
  const [catalogue, setCatalogue] = useState([]);
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [lastCheck, setLastCheck] = useState(null);
  const [autoCheck, setAutoCheck] = useState(false);
  const [checking, setChecking] = useState(false);
  const [toast, setToast] = useState(null);
  const [csvText, setCsvText] = useState("");
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [ready, setReady] = useState(false);
  const intervalRef = useRef(null);
  const toastRef = useRef(null);

  // ── Persistence ────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const load = async (k, setter) => {
        try { const r = await window.storage.get(k); if (r?.value) setter(JSON.parse(r.value)); } catch {}
      };
      await Promise.all([
        load("cat", setCatalogue), load("pend", setPending), load("hist", setHistory),
        (async () => {
          try {
            const r = await window.storage.get("lastCheck"); if (r?.value) setLastCheck(r.value);
            const ac = await window.storage.get("autoCheck"); if (ac?.value === "true") setAutoCheck(true);
          } catch {}
        })()
      ]);
      setReady(true);
    })();
  }, []);

  const save = async (k, d) => { try { await window.storage.set(k, JSON.stringify(d)); } catch {} };
  const setCat  = async d => { setCatalogue(d); await save("cat",  d); };
  const setPend = async d => { setPending(d);   await save("pend", d); };
  const setHist = async d => { setHistory(d);   await save("hist", d); };

  // ── Toast ──────────────────────────────────────────────────────────────
  const notify = (msg, type = "ok") => {
    clearTimeout(toastRef.current); setToast({ msg, type });
    toastRef.current = setTimeout(() => setToast(null), 3500);
  };

  // ── Catalogue CRUD ─────────────────────────────────────────────────────
  const handleAdd = async () => {
    if (!newName.trim()) { notify("Entrez un nom d'article", "err"); return; }
    if (!newUrl.trim() || !newUrl.toLowerCase().includes("temu")) { notify("Lien Temu invalide", "err"); return; }
    const item = { id: uid(), name: newName.trim(), temuUrl: newUrl.trim(), addedAt: new Date().toISOString() };
    await setCat([...catalogue, item]); setNewName(""); setNewUrl(""); notify("Article ajouté ✓");
  };

  const handleImport = async () => {
    const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
    const added = [], errs = [];
    lines.forEach((line, i) => {
      const p = parseCsvLine(line);
      if (p.length >= 2 && p[0] && p[1]?.toLowerCase().includes("temu"))
        added.push({ id: uid(), name: p[0], temuUrl: p[1], addedAt: new Date().toISOString() });
      else errs.push(i + 1);
    });
    if (!added.length) { notify("Aucun article valide. Format : Nom;https://temu.com/...", "err"); return; }
    await setCat([...catalogue, ...added]); setCsvText("");
    notify(`${added.length} article(s) importé(s)${errs.length ? ` · ${errs.length} ignorée(s)` : ""}`);
  };

  const handleDel = async id => await setCat(catalogue.filter(c => c.id !== id));

  // ── Gmail check ────────────────────────────────────────────────────────
  const checkGmail = useCallback(async () => {
    if (checking) return; setChecking(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 1500,
          system: "Réponds UNIQUEMENT en JSON valide, sans markdown ni backticks.",
          messages: [{ role: "user", content: `Utilise Gmail pour chercher les emails de vente Vinted.\nFais une recherche Gmail avec la requête: "from:vinted" et filtre les emails qui parlent de vente ou d'article vendu (sujet ou corps contenant "vendu", "vente", "félicitations", "congratulations", "sold").\nCherche parmi les 30 emails les plus récents.\n\nPour chaque email de VENTE trouvé, extrais le titre/nom exact de l'article vendu.\n\nRéponds UNIQUEMENT en JSON:\n{"ventes": [{"titre": "nom de l'article", "date": "date ISO", "sujet_email": "sujet"}]}` }],
          mcp_servers: [GMAIL_MCP]
        })
      });
      const data = await res.json();
      const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      const jsonStr = text.match(/\{[\s\S]*"ventes"[\s\S]*\}/)?.[0];
      const now = new Date().toISOString(); setLastCheck(now); await window.storage.set("lastCheck", now);
      if (!jsonStr) { notify("Aucune vente détectée", "info"); return; }
      const { ventes = [] } = JSON.parse(jsonStr);
      if (!ventes.length) { notify("Aucune nouvelle vente Vinted"); return; }
      const known = new Set([...pending.map(s => s.titre), ...history.map(s => s.titre)]);
      const novel = ventes.filter(v => !known.has(v.titre)).map(v => {
        const { item, score } = matchCatalogue(v.titre, catalogue);
        return { ...v, id: uid(), temuUrl: item?.temuUrl || null, catalogueName: item?.name || null, matchScore: score };
      });
      if (!novel.length) { notify(`${ventes.length} vente(s) déjà traitée(s)`); return; }
      await setPend([...novel, ...pending]); setTab("surveillance");
      notify(`🎉 ${novel.length} nouvelle(s) vente(s) Vinted !`);
    } catch (err) { notify("Erreur Gmail : " + err.message, "err"); }
    finally { setChecking(false); }
  }, [checking, catalogue, pending, history]);

  // ── Auto-check ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (autoCheck && ready) intervalRef.current = setInterval(checkGmail, 15 * 60 * 1000);
    else clearInterval(intervalRef.current);
    return () => clearInterval(intervalRef.current);
  }, [autoCheck, ready, checkGmail]);

  const toggleAuto = async () => {
    const nv = !autoCheck; setAutoCheck(nv);
    try { await window.storage.set("autoCheck", String(nv)); } catch {}
  };

  // ── Add to cart ────────────────────────────────────────────────────────
  const handleCart = (sale) => {
    window.open(sale.temuUrl, "_blank");
    window.sendPrompt(
      `🛒 Automation Temu — Article vendu sur Vinted !\n\nArticle vendu : "${sale.titre}"\nLien Temu : ${sale.temuUrl}\n\nUtilise Claude pour Chrome pour :\n1. Naviguer sur cette URL Temu\n2. Sélectionner la bonne variante (taille/couleur) si besoin\n3. Cliquer sur "Ajouter au panier"\n4. Me confirmer quand c'est dans le panier`
    );
    handleIgnore(sale, true);
  };

  const handleIgnore = async (sale, ordered = false) => {
    await setHist([{ ...sale, processedAt: new Date().toISOString(), ordered }, ...history]);
    await setPend(pending.filter(s => s.id !== sale.id));
  };

  // ── Styles ─────────────────────────────────────────────────────────────
  const C = { bg:"#0d0d14",surf:"#12121e",card:"#181828",bord:"#252542",pur:"#7c3aed",purL:"#a78bfa",grn:"#059669",red:"#e11d48",txt:"#e2e2f0",mut:"#6b6b8f",dim:"#2a2a45" };
  const inp = { background:"#0a0a12",border:`1px solid ${C.bord}`,borderRadius:7,color:C.txt,padding:"8px 12px",fontSize:12,outline:"none",width:"100%",boxSizing:"border-box" };
  const btn = (bg, off=false) => ({ background:off?C.dim:bg,border:"none",color:off?C.mut:"#fff",padding:"9px 16px",borderRadius:8,fontWeight:700,cursor:off?"not-allowed":"pointer",fontSize:12 });

  return (
    <div style={{ fontFamily:"Inter,system-ui,sans-serif",background:C.bg,minHeight:"100vh",color:C.txt }}>

      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed",top:14,right:14,zIndex:9999,background:toast.type==="err"?"#3b0a1a":toast.type==="info"?"#0a1a3b":"#0a3a1a",border:`1px solid ${toast.type==="err"?C.red:toast.type==="info"?"#3b6bff":C.grn}`,color:"#fff",padding:"10px 16px",borderRadius:10,fontSize:12,boxShadow:"0 8px 30px rgba(0,0,0,.6)",maxWidth:290,lineHeight:1.4 }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#0e0c28,#0b1628)",borderBottom:`1px solid ${C.bord}`,padding:"14px 20px",display:"flex",alignItems:"center",gap:10 }}>
        <span style={{ fontSize:22 }}>🔄</span>
        <div>
          <div style={{ fontWeight:800,fontSize:15,letterSpacing:.2 }}>Vinted <span style={{ color:C.purL }}>×</span> Temu</div>
          <div style={{ fontSize:10,color:C.mut }}>Automatisation achat-revente</div>
        </div>
        <div style={{ marginLeft:"auto",textAlign:"right" }}>
          {lastCheck && <div style={{ fontSize:10,color:C.mut }}>Vérifié · {fmt(lastCheck)}</div>}
          {autoCheck && <div style={{ fontSize:10,color:"#4ade80",marginTop:2 }}>● Surveillance active</div>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ background:C.surf,borderBottom:`1px solid ${C.bord}`,display:"flex" }}>
        {[
          { id:"surveillance",e:"📡",l:"Surveillance",badge:pending.length,red:true },
          { id:"catalogue",   e:"📋",l:"Catalogue",   badge:catalogue.length,red:false },
          { id:"historique",  e:"📊",l:"Historique",  badge:null,red:false }
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ background:"none",border:"none",cursor:"pointer",padding:"11px 16px",display:"flex",alignItems:"center",gap:6,color:tab===t.id?C.purL:C.mut,borderBottom:`2px solid ${tab===t.id?C.purL:"transparent"}`,fontSize:12,fontWeight:700 }}>
            <span>{t.e}</span>{t.l}
            {t.badge!==null && <span style={{ background:t.red&&t.badge>0?C.red:C.dim,color:t.red&&t.badge>0?"#fff":C.mut,borderRadius:12,padding:"1px 7px",fontSize:10,fontWeight:800 }}>{t.badge}</span>}
          </button>
        ))}
      </div>

      <div style={{ padding:"18px 16px",maxWidth:740,margin:"0 auto" }}>

        {/* ─── SURVEILLANCE ─── */}
        {tab==="surveillance" && (
          <div>
            <div style={{ display:"flex",gap:10,marginBottom:18,alignItems:"center",flexWrap:"wrap" }}>
              <button onClick={checkGmail} disabled={checking} style={{ ...btn(`linear-gradient(135deg,${C.pur},#4338ca)`,checking),display:"flex",alignItems:"center",gap:7 }}>
                <span style={checking?{display:"inline-block",animation:"spin 1s linear infinite"}:{}}>{checking?"⟳":"🔍"}</span>
                {checking?"Vérification en cours…":"Vérifier les ventes Gmail"}
              </button>
              <div onClick={toggleAuto} style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",background:C.card,border:`1px solid ${C.bord}`,borderRadius:8,padding:"7px 12px" }}>
                <span style={{ fontSize:11,color:C.mut }}>Auto (15 min)</span>
                <div style={{ width:34,height:18,borderRadius:9,background:autoCheck?C.pur:C.dim,position:"relative",transition:"background .2s" }}>
                  <div style={{ width:14,height:14,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:autoCheck?18:2,transition:"left .2s" }}/>
                </div>
              </div>
            </div>

            {!pending.length ? (
              <div style={{ textAlign:"center",padding:"56px 0",color:C.dim }}>
                <div style={{ fontSize:48,marginBottom:14 }}>📭</div>
                <div style={{ color:C.mut,fontSize:14,fontWeight:600 }}>Aucune vente en attente</div>
                <div style={{ color:C.dim,fontSize:11,marginTop:6 }}>Clique sur "Vérifier" pour scanner ton Gmail Vinted</div>
              </div>
            ) : (
              <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
                {pending.map(sale => (
                  <div key={sale.id} style={{ background:C.card,border:`1px solid ${C.bord}`,borderRadius:12,padding:14 }}>
                    <div style={{ display:"flex",gap:12,alignItems:"flex-start" }}>
                      <span style={{ fontSize:24,marginTop:1 }}>💰</span>
                      <div style={{ flex:1,minWidth:0 }}>
                        <div style={{ fontWeight:700,fontSize:14,marginBottom:3 }}>{sale.titre}</div>
                        <div style={{ fontSize:11,color:C.mut,marginBottom:8 }}>Vendu · {fmt(sale.date)}</div>
                        {sale.temuUrl ? (
                          <div style={{ display:"inline-flex",alignItems:"center",gap:6,background:"#0a2616",border:"1px solid #1a5030",borderRadius:7,padding:"5px 10px" }}>
                            <span>✅</span>
                            <span style={{ fontSize:11,color:"#4ade80" }}>
                              → <b>{sale.catalogueName}</b>
                              {sale.matchScore<1 && <span style={{ color:"#86efac",marginLeft:4 }}>({Math.round(sale.matchScore*100)}%)</span>}
                            </span>
                          </div>
                        ) : (
                          <div style={{ display:"inline-flex",alignItems:"center",gap:6,background:"#2a1a08",border:"1px solid #5a3810",borderRadius:7,padding:"5px 10px" }}>
                            <span>⚠️</span>
                            <span style={{ fontSize:11,color:"#fbbf24" }}>Pas dans le catalogue — ajoute le lien Temu</span>
                          </div>
                        )}
                      </div>
                      <div style={{ display:"flex",flexDirection:"column",gap:6,minWidth:140 }}>
                        <button onClick={() => handleCart(sale)} disabled={!sale.temuUrl} style={btn(sale.temuUrl?`linear-gradient(135deg,${C.grn},#047857)`:C.dim,!sale.temuUrl)}>
                          🛒 Ajouter au panier
                        </button>
                        <button onClick={() => handleIgnore(sale)} style={{ background:"none",border:`1px solid ${C.bord}`,color:C.mut,padding:"6px 16px",borderRadius:7,cursor:"pointer",fontSize:11,fontWeight:600 }}>
                          Ignorer
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── CATALOGUE ─── */}
        {tab==="catalogue" && (
          <div>
            <div style={{ background:C.card,border:`1px solid ${C.bord}`,borderRadius:12,padding:16,marginBottom:14 }}>
              <div style={{ fontWeight:700,fontSize:13,marginBottom:8 }}>📥 Import depuis Excel (CSV)</div>
              <div style={{ fontSize:11,color:C.mut,marginBottom:10,lineHeight:1.6 }}>
                Dans Excel → <b>Fichier → Enregistrer sous → CSV</b><br/>
                Format par ligne : <code style={{ color:C.purL,background:"#1a1a3a",padding:"2px 6px",borderRadius:4 }}>Nom de l'article ; https://www.temu.com/...</code>
              </div>
              <textarea value={csvText} onChange={e=>setCsvText(e.target.value)}
                placeholder={"T-shirt Nike Blanc;https://www.temu.com/...\nJean Levi's 501;https://www.temu.com/..."}
                style={{ ...inp,height:90,resize:"vertical",fontFamily:"monospace",fontSize:11 }}/>
              <button onClick={handleImport} style={{ ...btn(C.pur),marginTop:8 }}>Importer le CSV</button>
            </div>

            <div style={{ background:C.card,border:`1px solid ${C.bord}`,borderRadius:12,padding:16,marginBottom:20 }}>
              <div style={{ fontWeight:700,fontSize:13,marginBottom:10 }}>➕ Ajouter manuellement</div>
              <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
                <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Nom de l'article (tel que sur Vinted)" style={{ ...inp,flex:"1 1 140px" }}/>
                <input value={newUrl}  onChange={e=>setNewUrl(e.target.value)}  placeholder="https://www.temu.com/..."            style={{ ...inp,flex:"2 1 200px" }}/>
                <button onClick={handleAdd} style={{ ...btn(`linear-gradient(135deg,${C.pur},#4338ca)`),whiteSpace:"nowrap" }}>Ajouter</button>
              </div>
            </div>

            {!catalogue.length ? (
              <div style={{ textAlign:"center",padding:"40px 0" }}>
                <div style={{ fontSize:40,marginBottom:10 }}>📋</div>
                <div style={{ color:C.mut,fontSize:13,fontWeight:600 }}>Catalogue vide</div>
                <div style={{ color:C.dim,fontSize:11,marginTop:4 }}>Importe ton fichier Excel ou ajoute des articles manuellement</div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize:11,color:C.mut,marginBottom:10,fontWeight:600 }}>{catalogue.length} article(s) dans le catalogue</div>
                <div style={{ display:"flex",flexDirection:"column",gap:7 }}>
                  {catalogue.map(item => (
                    <div key={item.id} style={{ background:C.card,border:`1px solid ${C.bord}`,borderRadius:10,padding:"11px 13px",display:"flex",alignItems:"center",gap:10 }}>
                      <span style={{ fontSize:16 }}>🏷️</span>
                      <div style={{ flex:1,minWidth:0 }}>
                        <div style={{ fontWeight:600,fontSize:13 }}>{item.name}</div>
                        <a href={item.temuUrl} target="_blank" rel="noreferrer" style={{ fontSize:10,color:C.purL,textDecoration:"none" }}>
                          {item.temuUrl.length>58?item.temuUrl.slice(0,58)+"…":item.temuUrl}
                        </a>
                      </div>
                      <button onClick={() => handleDel(item.id)} style={{ background:"none",border:"none",cursor:"pointer",color:C.mut,fontSize:18,lineHeight:1,padding:"0 4px" }}>×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── HISTORIQUE ─── */}
        {tab==="historique" && (
          <div>
            {!history.length ? (
              <div style={{ textAlign:"center",padding:"56px 0" }}>
                <div style={{ fontSize:44,marginBottom:12 }}>📊</div>
                <div style={{ color:C.mut,fontSize:14,fontWeight:600 }}>Aucune vente traitée</div>
                <div style={{ color:C.dim,fontSize:11,marginTop:4 }}>L'historique apparaîtra ici</div>
              </div>
            ) : (
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                {history.map((s,i) => (
                  <div key={i} style={{ background:C.card,border:`1px solid ${C.bord}`,borderRadius:10,padding:"11px 13px",display:"flex",alignItems:"center",gap:10 }}>
                    <span style={{ fontSize:18 }}>{s.ordered?"✅":"⏭️"}</span>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontWeight:600,fontSize:12 }}>{s.titre}</div>
                      <div style={{ fontSize:10,color:C.mut,marginTop:2 }}>
                        {s.ordered?`Commandé${s.catalogueName?` → ${s.catalogueName}`:""}`:  "Ignoré"} · {fmt(s.processedAt)}
                      </div>
                    </div>
                    {s.temuUrl && <a href={s.temuUrl} target="_blank" rel="noreferrer" style={{ fontSize:11,color:C.purL,textDecoration:"none",whiteSpace:"nowrap" }}>Voir Temu →</a>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}*{box-sizing:border-box;margin:0;padding:0}button:hover:not(:disabled){opacity:.85}input:focus,textarea:focus{border-color:#7c3aed!important}`}</style>
    </div>
  );
}
