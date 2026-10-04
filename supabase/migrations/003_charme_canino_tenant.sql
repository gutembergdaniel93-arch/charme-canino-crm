-- Personalização inicial do tenant da instalação Charme Canino.
-- Executada somente no projeto Supabase novo que o instalador cria para o cliente.
UPDATE public.tenants
SET name = 'Charme Canino', slug = 'charme-canino'
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND slug = 'default';