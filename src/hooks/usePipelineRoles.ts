import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

/**
 * Papéis de pipeline lidos da tabela `config` (key `PIPELINE_ROLES`).
 *
 * value = JSON:
 * {
 *   "pre_vendas": "<uuid do pipeline de pré-vendas>",
 *   "closer": "<uuid do pipeline de closer>",
 *   "webinario": "<uuid do pipeline de webinário>",
 *   "stages": {
 *     "closer_call_agendada": "<uuid>",
 *     "closer_noshow": "<uuid>",
 *     "closer_call_realizada": "<uuid>",
 *     "refund_closer": "<uuid>",
 *     "refund_webinario": "<uuid>"
 *   }
 * }
 *
 * Tudo opcional: quando a key não existe (ou está incompleta), as features
 * que dependem dela degradam graciosamente (ficam escondidas/inativas).
 */
export interface PipelineRoles {
  preVendas?: string;
  closer?: string;
  webinario?: string;
  stages: Record<string, string>;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export function parsePipelineRoles(raw: string | null | undefined): PipelineRoles {
  if (!raw) return { stages: {} };
  try {
    const parsed = JSON.parse(raw);
    const stages: Record<string, string> = {};
    if (parsed?.stages && typeof parsed.stages === 'object') {
      for (const [k, v] of Object.entries(parsed.stages)) {
        if (typeof v === 'string' && v) stages[k] = v;
      }
    }
    return {
      preVendas: typeof parsed?.pre_vendas === 'string' && parsed.pre_vendas ? parsed.pre_vendas : undefined,
      closer: typeof parsed?.closer === 'string' && parsed.closer ? parsed.closer : undefined,
      webinario: typeof parsed?.webinario === 'string' && parsed.webinario ? parsed.webinario : undefined,
      stages,
    };
  } catch {
    return { stages: {} };
  }
}

async function fetchConfigRaw(key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) return null;
  return (data as { value: string | null } | null)?.value ?? null;
}

// Cache module-level pra uso fora de componentes React (funções async soltas)
const configCache = new Map<string, { value: string | null; at: number }>();

/** Lê 1 key da tabela `config` fora de componentes React (com cache de 5min). */
export async function fetchConfigValue(key: string): Promise<string | null> {
  const hit = configCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fetchConfigRaw(key);
  configCache.set(key, { value, at: Date.now() });
  return value;
}

/** Versão não-hook de usePipelineRoles, pra funções async fora de componentes. */
export async function fetchPipelineRoles(): Promise<PipelineRoles> {
  return parsePipelineRoles(await fetchConfigValue('PIPELINE_ROLES'));
}

/** Hook genérico: lê 1 key da tabela `config`. Retorna null se não existir. */
export function useConfigValue(key: string) {
  return useQuery({
    queryKey: ['config-value', key],
    queryFn: () => fetchConfigRaw(key),
    staleTime: CACHE_TTL_MS,
  });
}

/** Hook: papéis de pipeline (pré-vendas / closer / webinário + stages nomeados). */
export function usePipelineRoles(): PipelineRoles {
  const { data } = useConfigValue('PIPELINE_ROLES');
  return useMemo(() => parsePipelineRoles(data), [data]);
}
