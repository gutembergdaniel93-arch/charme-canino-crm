// Helpers de resolução de TENANT nas edge functions (Onda B3).
//
// Regra: NUNCA assumir tenant único. O tenant vem de uma destas fontes,
// nesta ordem de preferência:
//   1. JWT do usuário (functions chamadas pelo frontend)  → getTenantFromRequest
//   2. Entidade do evento (webhooks: instância/conta tem tenant_id)
//   3. A própria linha processada (crons: linhas têm tenant_id pós-B1)
// Sem tenant identificável → retornar null e deixar o helper de config
// cair no fallback global (comportamento single-tenant).

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/** Extrai app_metadata.tenant_id do JWT do request (sem validar assinatura —
 *  a validação é do gateway quando verify_jwt=true). Retorna null se ausente. */
export function getTenantFromRequest(req: Request): string | null {
  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token || token.split(".").length !== 3) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
      )
    );
    return payload?.app_metadata?.tenant_id || null;
  } catch {
    return null;
  }
}

/** Tenant do request com fallback pro tenant default (instalação single-tenant). */
export function getTenantFromRequestOrDefault(req: Request): string {
  return getTenantFromRequest(req) || DEFAULT_TENANT;
}

export { DEFAULT_TENANT };
