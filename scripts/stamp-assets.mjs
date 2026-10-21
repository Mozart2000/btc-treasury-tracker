// Rewrites site/index.html so style.css and app.js include a content hash.
// GitHub Pages serves Cache-Control: max-age=600. Without a new URL, a visitor
// can receive the new HTML and keep running the previously cached app.js.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = ['style.css', 'app.js'];

export function assetVersion(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

export async function stampAssets(siteDir) {
  const indexPath = path.join(siteDir, 'index.html');
  let html = await readFile(indexPath, 'utf8');
  const stamped = [];
  for (const name of ASSETS) {
    const version = assetVersion(await readFile(path.join(siteDir, name)));
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`((?:href|src)=["'])${escaped}(?:\\?[^"']*)?(["'])`, 'g');
    let count = 0;
    const next = html.replace(re, (_m, open, close) => {
      count += 1;
      return `${open}${name}?v=${version}${close}`;
    });
    if (!count) throw new Error(`index.html has no reference to ${name}`);
    html = next;
    stamped.push(`${name}?v=${version}`);
  }
  await writeFile(indexPath, html);
  return stamped;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const site = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'site');
  stampAssets(site)
    .then((stamped) => { for (const line of stamped) console.log(line); })
    .catch((e) => { console.error(e); process.exit(1); });
}
