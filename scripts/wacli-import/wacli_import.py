#!/usr/bin/env python3
"""
Ponte wacli -> CRM Charme Canino (Supabase). SOMENTE LEITURA do lado WhatsApp.

- Lê ~/.wacli/wacli.db e ~/.wacli/session.db em modo read-only (sqlite mode=ro).
- Nunca chama o binário wacli, nunca envia mensagem, nunca escreve em grupo.
- Padrão = DRY-RUN: gera prévia em ./out/ e não toca no Supabase.
- --apply: grava no Supabase via PostgREST com chave SECRETA (service_role / sb_secret_),
  lida de variável de ambiente. Upserts idempotentes, sem DELETE.

Uso:
  python3 wacli_import.py                 # dry-run (prévia)
  SUPABASE_URL=... SUPABASE_SECRET_KEY=... python3 wacli_import.py --apply
Opções: --since YYYY-MM-DD  --wacli-dir PATH  --config PATH
"""
import argparse, json, os, re, sqlite3, sys, time, unicodedata, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
BRT = timezone(timedelta(hours=-3))

AD_SERVICE = re.compile(r"^An[uú]ncio do (Instagram|Facebook)\s*\n?.*banho com oz[oô]nio", re.I | re.S)
AD_COURSE = re.compile(r"^An[uú]ncio do (Instagram|Facebook)\s*\n?.*curso", re.I | re.S)
AD_ANY = re.compile(r"^An[uú]ncio do (Instagram|Facebook)", re.I)
AD_FIRST_CLIENT = re.compile(r"^Ol[aá]! Posso ter mais informa[cç][oõ]es sobre isso\?", re.I)


def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def digits(s):
    return re.sub(r"\D", "", s or "")


def phone_key(p):
    """Chave de dedupe: DDI+DDD + últimos 8 dígitos (resolve o 9º dígito)."""
    p = digits(p)
    if p.startswith("55") and len(p) in (12, 13):
        return p[:4] + p[-8:]
    return p


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def ro(path):
    return sqlite3.connect("file:%s?mode=ro" % path, uri=True)


# ---------------------------------------------------------------- leitura wacli
def load_wacli(wdir, since_ts):
    db = ro(os.path.join(wdir, "wacli.db"))
    db.row_factory = sqlite3.Row
    lid_map = {}
    sp = os.path.join(wdir, "session.db")
    if os.path.exists(sp):
        s = ro(sp)
        for lid, pn in s.execute("select lid, pn from whatsmeow_lid_map"):
            lid_map[digits(lid)] = digits(pn)
        s.close()
    contacts = {r["jid"]: dict(r) for r in db.execute("select * from contacts")}
    chats = {r["jid"]: dict(r) for r in db.execute("select * from chats")}
    msgs = {}
    q = ("select chat_jid, msg_id, sender_jid, sender_name, ts, from_me, text, display_text, "
         "quoted_msg_id, is_forwarded, reaction_to_id, reaction_emoji, media_type, media_caption, "
         "filename, mime_type, revoked, deleted_for_me, edited, edited_ts from messages "
         "where ts >= ? order by chat_jid, ts, rowid")
    for r in db.execute(q, (since_ts,)):
        msgs.setdefault(r["chat_jid"], []).append(dict(r))
    calls = {}
    for r in db.execute("select chat_jid, count(*) n, max(ts) last from call_events group by chat_jid"):
        calls[r["chat_jid"]] = {"n": r["n"], "last": r["last"]}
    db.close()
    return contacts, chats, msgs, lid_map, calls


def chat_phone(jid, lid_map):
    user, _, dom = jid.partition("@")
    if dom == "s.whatsapp.net":
        return digits(user)
    if dom == "lid":
        return lid_map.get(digits(user))
    return None


def word_match(name_n, pattern):
    return re.search(r"(^|\W)" + re.escape(norm(pattern)) + r"(\W|$)", name_n) is not None


def classify_origin(ms, history_start, window_days):
    """anuncio | anuncio_curso | existente | outros  (+ evidência)."""
    if not ms:
        return "sem_conversa", {"motivo": "contato da agenda sem mensagens no histórico do wacli"}
    for i, m in enumerate(ms):
        t = (m["text"] or m["display_text"] or "").strip()
        is_ad = AD_ANY.match(t) or (not m["from_me"] and AD_FIRST_CLIENT.match(t))
        if not is_ad:
            continue
        ev = {"ad_marker_at": iso(m["ts"]), "ad_marker_text": t[:160], "msgs_before_marker": i}
        if AD_COURSE.match(t):
            return "anuncio_curso", ev
        if i == 0:
            ev["ad_kind"] = "servico" if AD_SERVICE.match(t) else "generico"
            return "anuncio", ev
        return "existente", dict(ev, motivo="já tinha conversa antes do anúncio")
    first = ms[0]["ts"]
    if first < history_start + window_days * 86400:
        return "existente", {"motivo": "conversa já existia no início do histórico do wacli", "first_msg_at": iso(first)}
    return "outros", {"first_msg_at": iso(first)}


def msg_type(m):
    mt = (m["media_type"] or "").strip()
    return mt if mt else "text"


def msg_content(m):
    t = m["display_text"] or m["text"] or m["media_caption"]
    if t:
        return t
    mt = msg_type(m)
    return {"audio": "🎤 [Áudio]", "image": "[Imagem]", "video": "[Vídeo]", "sticker": "[Figurinha]",
            "document": "[Documento] %s" % (m["filename"] or ""), "location": "[Localização]",
            "live_location": "[Localização ao vivo]", "gif": "[GIF]"}.get(mt, "[Mídia]")


# ---------------------------------------------------------------- montagem
def build(cfg, wdir, since_ts):
    contacts, chats, msgs, lid_map, calls = load_wacli(wdir, since_ts)
    all_ts = [m["ts"] for ms in msgs.values() for m in ms]
    history_start = min(all_ts) if all_ts else 0
    team = {phone_key(k): v for k, v in cfg["team_numbers"].items()}
    store_key = phone_key(cfg["store_phone"])
    biz_re = [re.compile(p, re.I) for p in cfg["business_name_patterns"]]
    leads, messages, skipped = {}, [], {"grupo": 0, "newsletter_broadcast": 0, "lid_sem_telefone": 0,
                                         "reacoes": 0, "msgs_grupo": 0, "msgs_sem_lead": 0}
    review = []
    # contatos com telefone + chats DM
    jids = set(j for j in contacts if j.endswith("@s.whatsapp.net")) | set(j for j, c in chats.items() if c["kind"] == "dm" or j.endswith("@lid"))
    for jid in sorted(jids):
        if jid.endswith("@g.us"):
            continue
        phone = chat_phone(jid, lid_map)
        if not phone:
            skipped["lid_sem_telefone"] += 1
            continue
        key = phone_key(phone)
        pn_jid = phone + "@s.whatsapp.net"
        c = contacts.get(pn_jid) or contacts.get(jid) or {}
        ch = chats.get(jid) or chats.get(pn_jid) or {}
        ms = msgs.get(jid, []) + (msgs.get(pn_jid, []) if jid != pn_jid else [])
        ms.sort(key=lambda m: m["ts"])
        name = (c.get("full_name") or c.get("business_name") or c.get("push_name") or ch.get("name") or "").strip()
        lead = leads.get(key)
        if lead is None:
            lead = {"key": key, "phone": phone, "name": name, "jids": set(), "msgs": [], "contact": c, "chat": ch}
            leads[key] = lead
        lead["jids"].add(jid)
        if not lead["name"] and name:
            lead["name"] = name
        lead["msgs"].extend(ms)
    for jid, c in chats.items():
        if c["kind"] == "group" or jid.endswith("@g.us"):
            skipped["grupo"] += 1
            skipped["msgs_grupo"] += len(msgs.get(jid, []))
        elif jid.endswith("@newsletter") or c["kind"] == "broadcast":
            skipped["newsletter_broadcast"] += 1

    out_leads = []
    rule_hits, pending_tags = {}, []
    for key, L in leads.items():
        ms = sorted({(m["chat_jid"], m["msg_id"]): m for m in L["msgs"]}.values(), key=lambda m: m["ts"])
        c = L["contact"]
        name = L["name"] or L["phone"]
        nn = norm(name + " " + (c.get("push_name") or "") + " " + (c.get("full_name") or ""))
        tags, notes, excl = set(), [], None
        if key == store_key:
            excl = "numero_da_loja"
        elif key in team:
            excl = "equipe"
            tags.add("equipe")
        elif any(norm(p) in nn for p in cfg["exclude_name_patterns"]):
            excl = "nao_atender"
            tags.add("nao_atender")
        elif c.get("business_name") or any(r.search(name) for r in biz_re):
            excl = "empresa"
            tags.add("empresa")
        origin, ev = classify_origin(ms, history_start, cfg["existing_client_window_days"])
        if excl not in ("numero_da_loja",):
            tags.add("origem:" + origin)
        for tag, rules in cfg["people_tags"].items():
            for rule in rules:
                words = rule.get("all") or rule.get("match") or []
                if rule.get("phones"):
                    hit = key in set(phone_key(p) for p in rule["phones"])
                else:
                    hit = all(word_match(nn, p) for p in words)
                if hit:
                    rule_hits.setdefault((tag, tuple(words)), []).append(key)
                    pending_tags.append((key, tag, rule, words, name, L["phone"]))
        if excl:
            tags.add("excluir_campanhas")
        inbound = [m for m in ms if not m["from_me"] and not m["reaction_emoji"]]
        outbound = [m for m in ms if m["from_me"] and not m["reaction_emoji"]]
        lead = {
            "name": name, "phone": L["phone"], "phone_key": key,
            "source": "whatsapp", "original_source": "anuncio_meta" if origin == "anuncio" else origin,
            "utm_source": "instagram_facebook_ads" if origin in ("anuncio", "anuncio_curso") else None,
            "tags": sorted(tags), "is_internal_contact": excl in ("equipe", "numero_da_loja"),
            "etapa_funil": "lead_anuncio" if origin == "anuncio" else None,
            "messages_count": len(ms),
            "last_message_received_at": iso(inbound[-1]["ts"]) if inbound else None,
            "last_message_sent_at": iso(outbound[-1]["ts"]) if outbound else None,
            "last_interaction_at": iso(ms[-1]["ts"]) if ms else None,
            "metadata": {"wacli": {"jids": sorted(L["jids"]), "push_name": c.get("push_name"),
                                   "full_name": c.get("full_name"), "business_name": c.get("business_name"),
                                   "first_msg_at": iso(ms[0]["ts"]) if ms else None,
                                   "calls": sum(calls.get(j, {}).get("n", 0) for j in L["jids"]),
                                   "imported_at": datetime.now(timezone.utc).isoformat()},
                         "charme": {"origem": origin, "origem_evidencia": ev, "excluido": excl,
                                    "notas_operacao": notes, "tags_por_nome_a_confirmar": bool(notes)}},
            "_msgs": ms, "_excl": excl,
        }
        if excl == "numero_da_loja":
            continue
        out_leads.append(lead)
        for m in ms:
            if m["reaction_emoji"]:
                skipped["reacoes"] += 1
                continue
            messages.append({"phone_key": key, "message_id": m["msg_id"], "remote_jid": m["chat_jid"],
                             "sender_phone": cfg["store_phone"] if m["from_me"] else L["phone"],
                             "sender_name": None if m["from_me"] else (m["sender_name"] or c.get("push_name")),
                             "content": msg_content(m), "message_type": msg_type(m),
                             "is_from_me": bool(m["from_me"]), "status": "imported",
                             "sent_at": iso(m["ts"]), "is_edited": bool(m["edited"]),
                             "is_deleted": bool(m["revoked"] or m["deleted_for_me"]),
                             "edited_at": iso(m["edited_ts"]) if m["edited"] and m["edited_ts"] else None,
                             "metadata": {"source": "wacli", "quoted_msg_id": m["quoted_msg_id"],
                                          "is_forwarded": bool(m["is_forwarded"]), "mime_type": m["mime_type"],
                                          "filename": m["filename"]}})
    by_key = {L["phone_key"]: L for L in out_leads}
    for key, tag, rule, words, name, phone in pending_tags:
        n_hits = len(rule_hits[(tag, tuple(words))])
        ambiguous = n_hits > 1 and not rule.get("phones")
        review.append({"tag": tag, "regra": list(words), "nome": name, "telefone": phone,
                       "aplicada": not ambiguous, "motivo": "ambíguo: %d contatos casaram" % n_hits if ambiguous else "único"})
        if ambiguous or key not in by_key:
            continue
        L = by_key[key]
        L["tags"] = sorted(set(L["tags"]) | {tag})
        L["metadata"]["charme"]["notas_operacao"].append({"tipo": tag, "nota": rule.get("note"), "regra": list(words)})
        L["metadata"]["charme"]["tags_por_nome_a_confirmar"] = True
        if tag in ("reclamacao", "ja_avaliou"):
            L["tags"] = sorted(set(L["tags"]) | {"sem_pedido_avaliacao"})
    return out_leads, messages, skipped, review, history_start


# ---------------------------------------------------------------- Supabase (PostgREST)
class PG:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}

    def req(self, method, path, body=None, prefer=None):
        h = dict(self.h)
        if prefer:
            h["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, headers=h, method=method)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(r, timeout=60) as resp:
                    txt = resp.read().decode() or "null"
                    return json.loads(txt)
            except urllib.error.HTTPError as e:
                msg = e.read().decode()[:400]
                if e.code >= 500 and attempt < 3:
                    time.sleep(2 * (attempt + 1)); continue
                raise RuntimeError("%s %s -> HTTP %s: %s" % (method, path.split("?")[0], e.code, msg))

    def get_all(self, path):
        out, off = [], 0
        while True:
            sep = "&" if "?" in path else "?"
            page = self.req("GET", "%s%slimit=1000&offset=%d" % (path, sep, off))
            out += page
            if len(page) < 1000:
                return out
            off += 1000


def preflight(pg, tenant):
    """Aborta se algo no CRM puder disparar mensagem/e-mail ao importar."""
    problems = []
    for t in ("tenants", "leads", "whatsapp_instances", "whatsapp_messages", "lead_interactions"):
        try:
            pg.req("GET", "%s?select=*&limit=0" % t)
        except RuntimeError as e:
            problems.append("tabela %s indisponível (%s)" % (t, str(e)[:120]))
    if problems:
        return problems
    if not pg.req("GET", "tenants?select=id&id=eq.%s" % tenant):
        problems.append("tenant %s não existe" % tenant)
    checks = [("ai_sales_agents?select=id&is_active=eq.true", "agente IA legado ativo (responderia mensagens importadas)"),
              ("email_automations?select=id&is_active=eq.true", "automação de e-mail ativa (dispara em lead_created)")]
    for path, why in checks:
        try:
            if pg.req("GET", path + "&limit=1"):
                problems.append(why)
        except RuntimeError as e:
            if "PGRST205" not in str(e) and "42703" not in str(e):
                problems.append("não consegui verificar: %s" % why)
    return problems


def apply(cfg, leads, messages):
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        sys.exit("Defina SUPABASE_URL e SUPABASE_SECRET_KEY (service_role/sb_secret_) no ambiente.")
    if key.startswith("sb_publishable_") or '"anon"' in key:
        sys.exit("Chave pública/anon não serve: a RLS só permite escrita a usuário autenticado/service_role.")
    tenant = cfg["tenant_id"]
    pg = PG(url, key)
    probs = preflight(pg, tenant)
    if probs:
        sys.exit("PRÉ-CHECAGEM FALHOU, nada foi gravado:\n - " + "\n - ".join(probs))
    stats = {"instance": None, "leads_inseridos": 0, "leads_atualizados": 0, "mensagens_enviadas_ao_upsert": 0, "notas": 0}
    # 1) instância wacli (sem api_url/api_key => impossível enviar por ela)
    inst = pg.req("GET", "whatsapp_instances?select=id&tenant_id=eq.%s&metadata->>provider=eq.wacli" % tenant)
    if inst:
        inst_id = inst[0]["id"]
    else:
        inst_id = pg.req("POST", "whatsapp_instances", {"tenant_id": tenant, "name": cfg["instance_name"],
                         "phone_number": cfg["store_phone"], "status": "disconnected", "purpose": "inbox",
                         "metadata": {"provider": "wacli", "read_only": True, "nao_enviar": True}},
                         prefer="return=representation")[0]["id"]
    stats["instance"] = inst_id
    # 2) leads: casa por phone_key (DDI+DDD+8 últimos) dentro do tenant
    existing = {}
    for r in pg.get_all("leads?select=id,phone,name,tags,metadata&tenant_id=eq.%s&phone=not.is.null" % tenant):
        existing.setdefault(phone_key(r["phone"]), r)
    lead_ids = {}
    for L in leads:
        body = {k: v for k, v in L.items() if not k.startswith("_") and k != "phone_key"}
        cur = existing.get(L["phone_key"])
        if cur:
            md = cur.get("metadata") or {}
            md.update({"wacli": body["metadata"]["wacli"], "charme": body["metadata"]["charme"]})
            patch = {"tags": sorted(set(cur.get("tags") or []) | set(body["tags"])), "metadata": md,
                     "messages_count": body["messages_count"],
                     "last_message_received_at": body["last_message_received_at"],
                     "last_message_sent_at": body["last_message_sent_at"],
                     "last_interaction_at": body["last_interaction_at"]}
            if not cur.get("name") or digits(cur["name"]) == digits(cur.get("phone")):
                patch["name"] = body["name"]
            pg.req("PATCH", "leads?id=eq.%s" % cur["id"], patch)
            lead_ids[L["phone_key"]] = cur["id"]; stats["leads_atualizados"] += 1
        else:
            body["tenant_id"] = tenant  # pipeline_stage_id fica nulo de propósito (evita trigger de cadência)
            new = pg.req("POST", "leads", body, prefer="return=representation")[0]
            lead_ids[L["phone_key"]] = new["id"]; existing[L["phone_key"]] = new; stats["leads_inseridos"] += 1
    # 3) notas operacionais (reclamação/avaliou/pendente) em lead_interactions, dedupe por metadata.dedupe
    have = set(r["metadata"].get("dedupe") for r in pg.get_all(
        "lead_interactions?select=metadata&tenant_id=eq.%s&interaction_type=eq.nota_importacao_charme" % tenant)
        if r.get("metadata"))
    for L in leads:
        for n in L["metadata"]["charme"]["notas_operacao"]:
            d = "%s|%s|%s" % (L["phone_key"], n["tipo"], ",".join(n["regra"]))
            if d in have:
                continue
            pg.req("POST", "lead_interactions", {"tenant_id": tenant, "lead_id": lead_ids[L["phone_key"]],
                   "interaction_type": "nota_importacao_charme",
                   "content": "[%s] %s (casado pelo nome - confirmar)" % (n["tipo"], n.get("nota") or ""),
                   "metadata": {"dedupe": d, "fonte": "operacao_charme_03-10-2026"}})
            have.add(d); stats["notas"] += 1
    # 4) mensagens: upsert ignorando duplicadas em (instance_id, message_id)
    batch = []
    for m in messages:
        row = {k: v for k, v in m.items() if k != "phone_key"}
        row.update({"tenant_id": tenant, "instance_id": inst_id, "lead_id": lead_ids.get(m["phone_key"])})
        batch.append(row)
        if len(batch) == 500:
            pg.req("POST", "whatsapp_messages?on_conflict=instance_id,message_id", batch,
                   prefer="resolution=ignore-duplicates,return=minimal")
            stats["mensagens_enviadas_ao_upsert"] += len(batch); batch = []
    if batch:
        pg.req("POST", "whatsapp_messages?on_conflict=instance_id,message_id", batch,
               prefer="resolution=ignore-duplicates,return=minimal")
        stats["mensagens_enviadas_ao_upsert"] += len(batch)
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--since", default=None)
    ap.add_argument("--wacli-dir", default=os.path.expanduser("~/.wacli"))
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    a = ap.parse_args()
    cfg = json.load(open(a.config, encoding="utf-8"))
    since = int(datetime.strptime(a.since, "%Y-%m-%d").replace(tzinfo=BRT).timestamp()) if a.since else 0
    leads, messages, skipped, review, hstart = build(cfg, a.wacli_dir, since)
    os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
    from collections import Counter
    summary = {
        "gerado_em": datetime.now(BRT).isoformat(), "historico_wacli_desde": iso(hstart) if hstart else None,
        "leads": len(leads), "mensagens": len(messages),
        "origem": dict(Counter(L["metadata"]["charme"]["origem"] for L in leads)),
        "excluidos": dict(Counter(L["_excl"] for L in leads if L["_excl"])),
        "tags": dict(Counter(t for L in leads for t in L["tags"])),
        "ignorados": skipped, "casamentos_por_nome": {"aplicados": sum(1 for x in review if x["aplicada"]), "ambiguos_nao_aplicados": sum(1 for x in review if not x["aplicada"])},
    }
    json.dump(summary, open(os.path.join(HERE, "out", "resumo.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(review, open(os.path.join(HERE, "out", "revisar-tags-por-nome.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump([{k: v for k, v in L.items() if not k.startswith("_")} for L in leads],
              open(os.path.join(HERE, "out", "previa-leads.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=list)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if a.apply:
        print(json.dumps(apply(cfg, leads, messages), ensure_ascii=False, indent=2))
    else:
        print("\nDRY-RUN: nada foi gravado. Prévia em scripts/wacli-import/out/. Use --apply para gravar.")


if __name__ == "__main__":
    main()
