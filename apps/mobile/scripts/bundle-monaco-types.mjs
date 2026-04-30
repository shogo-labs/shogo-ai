#!/usr/bin/env node
/**
 * Bundles `.d.ts` declaration files into a single TS module that exports
 * them as plain strings, so Monaco can register them as extraLibs without
 * a runtime fetch or a bundler-specific feature like Vite's `?raw`.
 *
 * Sources are pinned to the versions in apps/mobile/package.json. Re-run
 * after bumping React / React-DOM / their @types. The output file is
 * committed so production builds need no network access.
 *
 *   bun run bundle:monaco-types
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const REACT_TYPES = pkg.devDependencies['@types/react'].replace(/^[~^]/, '');
const REACT_DOM_TYPES = (pkg.devDependencies['@types/react-dom'] ?? '~19.1.0').replace(/^[~^]/, '');
const CSSTYPE = '3.1.3';
const PROP_TYPES = '15.7.13';

const SOURCES = [
  { id: 'REACT_DTS',             pkg: '@types/react',     ver: REACT_TYPES,     file: 'index.d.ts',         path: 'file:///node_modules/@types/react/index.d.ts' },
  { id: 'REACT_JSX_RUNTIME_DTS', pkg: '@types/react',     ver: REACT_TYPES,     file: 'jsx-runtime.d.ts',   path: 'file:///node_modules/@types/react/jsx-runtime.d.ts' },
  { id: 'REACT_JSX_DEV_DTS',     pkg: '@types/react',     ver: REACT_TYPES,     file: 'jsx-dev-runtime.d.ts', path: 'file:///node_modules/@types/react/jsx-dev-runtime.d.ts' },
  { id: 'REACT_DOM_DTS',         pkg: '@types/react-dom', ver: REACT_DOM_TYPES, file: 'index.d.ts',         path: 'file:///node_modules/@types/react-dom/index.d.ts' },
  { id: 'REACT_DOM_CLIENT_DTS',  pkg: '@types/react-dom', ver: REACT_DOM_TYPES, file: 'client.d.ts',        path: 'file:///node_modules/@types/react-dom/client.d.ts' },
  { id: 'CSSTYPE_DTS',           pkg: 'csstype',          ver: CSSTYPE,         file: 'index.d.ts',         path: 'file:///node_modules/csstype/index.d.ts' },
  { id: 'PROP_TYPES_DTS',        pkg: '@types/prop-types',ver: PROP_TYPES,      file: 'index.d.ts',         path: 'file:///node_modules/@types/prop-types/index.d.ts' },
];

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.text();
}

const blobs = [];
let totalBytes = 0;
for (const s of SOURCES) {
  const url = `https://unpkg.com/${s.pkg}@${s.ver}/${s.file}`;
  process.stdout.write(`  fetching ${s.pkg}@${s.ver}/${s.file} ... `);
  try {
    const content = await fetchText(url);
    blobs.push({ ...s, content });
    totalBytes += content.length;
    console.log(`${(content.length / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.log(`SKIP (${err.message})`);
  }
}

const banner = `// AUTO-GENERATED — do not edit by hand.
// Regenerate via: bun run bundle:monaco-types
// Sources: ${SOURCES.map((s) => `${s.pkg}@${s.ver}`).join(', ')}
// Generated: ${new Date().toISOString()}
//
// These declaration files power Monaco extraLibs so imports like
// \`import { useState } from "react"\` resolve to real types.

export type ExtraLib = { id: string; content: string; path: string };

`;

const consts = blobs
  .map((b) => `const ${b.id} = ${JSON.stringify(b.content)};\n`)
  .join('');

const list =
  `\nexport const EXTRA_LIBS: ExtraLib[] = [\n` +
  blobs.map((b) => `  { id: ${JSON.stringify(b.id)}, content: ${b.id}, path: ${JSON.stringify(b.path)} },\n`).join('') +
  `];\n`;

const out = banner + consts + list;
const outPath = resolve(ROOT, 'components/project/panels/ide/monaco/extraLibs.generated.ts');
writeFileSync(outPath, out, 'utf8');
console.log(`\nwrote ${outPath} (${(out.length / 1024).toFixed(1)} KB, ${blobs.length} libs, ${(totalBytes / 1024).toFixed(1)} KB raw)`);
