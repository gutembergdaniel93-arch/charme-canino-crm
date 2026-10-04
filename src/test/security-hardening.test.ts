import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('security hardening invariants', () => {
  it('keeps only genuine public callbacks without JWT verification', () => {
    const config = read('supabase/config.toml');
    const publicFunctions = [...config.matchAll(/\[functions\.([^\]]+)\]\s+verify_jwt = false/g)]
      .map((match) => match[1]).sort();
    expect(publicFunctions).toEqual([
      'book-meeting', 'google-ads-webhook',
      'google-calendar-webhook', 'livekit-token', 'livekit-webhook',
      'mentoring-public', 'meta-lead-webhook',
      'prospeccao-diagnostico-publico', 'receive-lead', 'telegram-webhook',
      'wavoip-webhook', 'whatsapp-cloud-webhook', 'whatsapp-webhook',
    ].sort());
    expect(read('supabase/functions/livekit-webhook/index.ts')).toContain('receiver.receive(body, authHeader)');
    expect(read('supabase/functions/livekit-token/index.ts')).toContain('privileged');
    expect(read('supabase/functions/mentoring-public/index.ts')).toContain('.eq("share_token", share_token)');
  });

  it('never ships long-lived AI keys to browser hooks', () => {
    const hooks = [
      'src/hooks/useGeminiCoach.ts',
      'src/hooks/useGeminiLiveCoach.ts',
      'src/hooks/useSalesCoach.ts',
    ].map(read).join('\n');
    expect(hooks).not.toContain('gemini-token');
    expect(hooks).not.toContain('@google/genai');
    expect(read('supabase/functions/soniox-token/index.ts')).toContain('temporary-api-key');
  });

  it('contains no fallback Supabase JWT in browser source', () => {
    const publicFormFiles = [
      'src/hooks/useMarketingForms.ts',
      'src/pages/public/FormEmbed.tsx',
    ].map(read).join('\n');
    expect(publicFormFiles).not.toMatch(/eyJhbGciOiJIUzI1Ni/);
  });

  it('does not grant the extension access to every website', () => {
    expect(read('extension/manifest.json')).not.toContain('<all_urls>');
  });

  it('disables public signup during installation', () => {
    expect(read('setup.sh')).toContain('"disable_signup":true');
  });
});
