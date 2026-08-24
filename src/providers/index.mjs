import { createBaileysProvider } from './baileys/manager.mjs';
import { createMockProvider } from './mock/index.mjs';

/**
 * Select the internal WhatsApp provider. Gakai's browser and public API stay
 * provider-neutral; this is the single server-side selection point.
 *
 * 'mock' is test-only (GAKAI_PROVIDER_KIND=mock) — an in-memory stand-in
 * with the same method surface as 'baileys', so the test suite never opens
 * a real WhatsApp connection.
 */
export function createProviderClient({ kind = 'baileys', ...options }) {
  switch (String(kind).toLowerCase()) {
    case 'baileys':
      return createBaileysProvider(options);
    case 'mock':
      return createMockProvider(options);
    default:
      throw new Error(`Unsupported Gakai provider adapter: ${kind}`);
  }
}
