import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

// Compile one React browser entrypoint. The Node server remains the API/backend.
await mkdir('public/assets', { recursive: true });
await build({ entryPoints: ['client/app.jsx'], bundle: true, format: 'esm', target: ['es2022'], outfile: 'public/assets/app.js', sourcemap: false, legalComments: 'none' });
