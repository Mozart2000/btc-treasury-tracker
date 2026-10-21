import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetVersion, stampAssets } from './stamp-assets.mjs';

test('stamps css and js with their content hashes and is idempotent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'stamp-'));
  const css = 'body{color:#fff}';
  const js = 'console.log(1)\n';
  await writeFile(path.join(dir, 'style.css'), css);
  await writeFile(path.join(dir, 'app.js'), js);
  await writeFile(path.join(dir, 'index.html'), [
    '<link rel="stylesheet" href="style.css">',
    '<script src="app.js"></script>',
    '',
  ].join('\n'));

  const cssVersion = assetVersion(Buffer.from(css));
  const jsVersion = assetVersion(Buffer.from(js));
  assert.equal(cssVersion, createHash('sha256').update(css).digest('hex').slice(0, 12));
  assert.notEqual(cssVersion, jsVersion);

  await stampAssets(dir);
  const once = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(once, new RegExp(`href="style\\.css\\?v=${cssVersion}"`));
  assert.match(once, new RegExp(`src="app\\.js\\?v=${jsVersion}"`));

  await stampAssets(dir);
  const twice = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.equal(twice, once);
  await rm(dir, { recursive: true });
});

test('refuses to deploy html that does not reference an asset', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'stamp-'));
  await writeFile(path.join(dir, 'style.css'), 'x');
  await writeFile(path.join(dir, 'app.js'), 'y');
  await writeFile(path.join(dir, 'index.html'), '<link rel="stylesheet" href="style.css">\n');
  await assert.rejects(() => stampAssets(dir), /app\.js/);
  await rm(dir, { recursive: true });
});
