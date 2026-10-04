// ONDA B4 — Onboarding de tenant (modo SaaS).
//
// POST { organization_name } — autenticado (JWT do usuário recém-cadastrado).
// Cria um TENANT novo isolado, grava app_metadata.tenant_id no usuário,
// cria o team_member admin e seeda os defaults (pipeline + PIPELINE_ROLES).
//
// Só funciona quando config.multi_tenant_enabled === 'true' — instalação
// single-tenant (default) retorna 403 e o app se comporta como hoje.
//
// Após o sucesso, o FRONT DEVE chamar supabase.auth.refreshSession() pra
// pegar o JWT novo com app_metadata.tenant_id (RLS passa a isolar tudo).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "tenant";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Cliente service_role — todas as operações usam tenant_id EXPLÍCITO.
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── 1. Modo SaaS ligado? ────────────────────────────────────────────
    const flag = await getIntegrationKey(supabase, "multi_tenant_enabled");
    if (flag !== "true") {
      return jsonResponse(
        {
          error:
            "Modo multi-tenant desativado. Esta instalação é single-tenant — " +
            "o cadastro normal já usa o workspace padrão. Para ativar o modo " +
            "SaaS, defina multi_tenant_enabled = 'true' na tabela config.",
        },
        403,
      );
    }

    // ── 2. Autenticação (JWT do usuário recém-cadastrado) ──────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized: missing bearer token" }, 401);
    }
    const jwt = authHeader.replace("Bearer ", "");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Unauthorized: invalid token" }, 401);
    }
    const user = userData.user;

    // ── 3. Payload ──────────────────────────────────────────────────────
    let body: { organization_name?: string } = {};
    try {
      body = await req.json();
    } catch {
      // body vazio tratado abaixo
    }
    const organizationName = (body.organization_name || "").trim();
    if (!organizationName || organizationName.length < 2) {
      return jsonResponse(
        { error: "Informe organization_name (nome da empresa/organização)." },
        400,
      );
    }
    if (organizationName.length > 120) {
      return jsonResponse(
        { error: "organization_name muito longo (máx. 120 caracteres)." },
        400,
      );
    }

    // ── 4. Usuário ainda NÃO pode pertencer a um tenant ────────────────
    if (user.app_metadata?.tenant_id) {
      return jsonResponse(
        { error: "Usuário já pertence a um workspace (tenant)." },
        409,
      );
    }
    const { data: existingMember } = await supabase
      .from("team_members")
      .select("id")
      .or(`auth_user_id.eq.${user.id},email.eq.${user.email}`)
      .limit(1)
      .maybeSingle();
    if (existingMember) {
      return jsonResponse(
        { error: "Usuário já faz parte de um time existente." },
        409,
      );
    }

    // ── 5. Cria o tenant ────────────────────────────────────────────────
    // slug único: base do nome + sufixo aleatório (evita colisão do UNIQUE)
    const slug = `${slugify(organizationName)}-${crypto.randomUUID().slice(0, 8)}`;
    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .insert({
        name: organizationName,
        slug,
        is_active: true,
        owner_user_id: user.id,
      })
      .select("id")
      .single();
    if (tenantErr || !tenant) {
      return jsonResponse(
        { error: `Erro ao criar tenant: ${tenantErr?.message}` },
        500,
      );
    }
    const tenantId: string = tenant.id;

    // Rollback best-effort se algo falhar daqui pra frente
    const rollback = async () => {
      try {
        await supabase.from("team_members").delete().eq("tenant_id", tenantId);
        await supabase.from("tenants").delete().eq("id", tenantId);
      } catch (_) { /* best effort */ }
    };

    // ── 6. JWT do usuário passa a carregar o tenant ─────────────────────
    const { error: updErr } = await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: { ...(user.app_metadata || {}), tenant_id: tenantId },
    });
    if (updErr) {
      await rollback();
      return jsonResponse(
        { error: `Erro ao vincular usuário ao tenant: ${updErr.message}` },
        500,
      );
    }

    // ── 7. team_member admin do tenant novo ─────────────────────────────
    const displayName =
      (user.user_metadata?.name as string | undefined) ||
      user.email?.split("@")[0] ||
      "Admin";
    const { error: tmErr } = await supabase.from("team_members").insert({
      tenant_id: tenantId,
      email: user.email,
      name: displayName,
      role: "admin",
      team: "admin",
      auth_user_id: user.id,
      is_active: true,
    });
    if (tmErr) {
      // desfaz o app_metadata e o tenant
      try {
        const meta = { ...(user.app_metadata || {}) } as Record<string, unknown>;
        delete meta.tenant_id;
        await supabase.auth.admin.updateUserById(user.id, { app_metadata: meta });
      } catch (_) { /* best effort */ }
      await rollback();
      return jsonResponse(
        { error: `Erro ao criar membro do time: ${tmErr.message}` },
        500,
      );
    }

    // ── 8. Profile criado no signup nasceu no tenant default — corrige ──
    await supabase
      .from("profiles")
      .update({ tenant_id: tenantId })
      .eq("id", user.id);

    // ── 9. Seed dos defaults do tenant (pipeline + PIPELINE_ROLES) ──────
    const { error: seedErr } = await supabase.rpc("tenant_seed_defaults", {
      p_tenant_id: tenantId,
    });
    if (seedErr) {
      // Tenant já está funcional (RLS + admin) — seed pode ser re-executado.
      console.error("[tenant-signup] Erro no seed de defaults:", seedErr.message);
    }

    return jsonResponse({
      tenant_id: tenantId,
      message:
        "Workspace criado. Chame supabase.auth.refreshSession() para " +
        "renovar o JWT com o tenant novo.",
    });
  } catch (err: any) {
    console.error("[tenant-signup] Erro inesperado:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Erro inesperado" },
      500,
    );
  }
});
