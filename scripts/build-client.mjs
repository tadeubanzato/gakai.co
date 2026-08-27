import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

// Compile one React browser entrypoint. The Node server remains the API/backend.
await mkdir('public/assets', { recursive: true });
await build({
  entryPoints: ['client/app.jsx'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: 'public/assets/app.js',
  sourcemap: false,
  legalComments: 'none',
  // Ship React's production build: smaller, faster, and without the
  // development-only behaviours (extra re-renders, stricter async checks)
  // that don't match how the app runs for real.
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
