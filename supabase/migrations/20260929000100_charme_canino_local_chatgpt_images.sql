-- Política do pacote Charme Canino: imagens são produzidas na sessão local do ChatGPT.
-- Desative caminhos de imagem Gemini herdados dos templates do CRM.
UPDATE public.agents_integration_providers
SET is_active = false
WHERE slug = 'gemini_image';

UPDATE public.agents_skill_catalog
SET default_usage_mode = 'disabled', is_recommended = false
WHERE slug = 'gemini_gerar_imagem';

UPDATE public.agents_tools
SET is_active = false, usage_mode = 'disabled'
WHERE provider = 'gemini_image' OR name = 'gemini_gerar_imagem';

UPDATE public.agents_registry
SET settings = jsonb_set(
  settings,
  '{native_tools}',
  COALESCE(settings->'native_tools', '[]'::jsonb) - 'image_generation',
  true
)
WHERE settings ? 'native_tools'
  AND settings->'native_tools' @> '["image_generation"]'::jsonb;

UPDATE public.agents_registry
SET system_prompt = replace(
  system_prompt,
  '- gemini_gerar_imagem',
  '- Para imagens: preparar o prompt e orientar a atendente a gerar no ChatGPT local; baixar e anexar o arquivo ao CRM. Não usar API de imagem.'
)
WHERE slug = 'template_heitor_conteudo'
  AND system_prompt LIKE '%gemini_gerar_imagem%';
