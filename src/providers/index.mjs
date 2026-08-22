import { createWahaClient } from './waha/client.mjs';

/**
 * Select the internal provider adapter. Gakai's browser and public API stay
 * provider-neutral; this is the single server-side selection point.
 */
export function createProviderClient({ kind = 'waha', ...options }) {
  switch (String(kind).toLowerCase()) {
    case 'waha':
      return createWahaClient(options);
    default:
      throw new Error(`Unsupported Gakai provider adapter: ${kind}`);
  }
}
