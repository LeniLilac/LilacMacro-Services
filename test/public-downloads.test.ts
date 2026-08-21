import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('download page keeps the concise annotated copy and requirements', async () => {
  const [html, css] = await Promise.all([
    readFile('public/downloads.html', 'utf8'),
    readFile('public/downloads.css', 'utf8'),
  ]);

  assert.match(html, /<h1 id="download-title">Download Lilac Macro<\/h1>/);
  assert.match(html, /<h2 id="requirements-title">System Requirements<\/h2>/);
  assert.match(html, /<h2 id="quickstart-title">Quick Start<\/h2>/);
  assert.match(html, /<h2 id="closing-title">Ready when you are\.<\/h2>/);
  assert.match(html, /<dd>Windows 10<\/dd>/);
  assert.match(html, /<dd>Windows 11<\/dd>/);
  assert.match(html, /<dd>1366 × 768<\/dd>/);
  assert.match(html, /<dd>1920 × 1080 or higher<\/dd>/);
  assert.match(css, /\.download-closing \{[^}]*align-items: center;/s);
  assert.doesNotMatch(html, /release-status|Browse all GitHub release listings/);

  for (const removedCopy of [
    'LILACMACRO FOR WINDOWS',
    'Your run starts',
    'Install LilacMacro, connect it to your Roblox window',
    'Before you install.',
    'SYSTEM / REQUIREMENTS',
    'LilacMacro is a self-contained 64-bit Windows app.',
    'Supported baseline',
    'Smoother setup and OCR',
    'Windows scale at 100%',
    'CPU mode',
    'NVIDIA GPU, compute capability 6.0+',
    'Roblox desktop app in windowed mode',
    'RAM guidance is for one local session.',
    'Install it.',
    'Two short walkthroughs will cover the whole path',
  ]) {
    assert.doesNotMatch(html, new RegExp(removedCopy.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('public pages use the same global header', async () => {
  const [landingHtml, downloadsHtml, siteCss] = await Promise.all([
    readFile('public/index.html', 'utf8'),
    readFile('public/downloads.html', 'utf8'),
    readFile('public/site.css', 'utf8'),
  ]);
  const headerPattern = /<header class="masthead">[\s\S]*?<\/header>/;
  const landingHeader = landingHtml.match(headerPattern)?.[0];
  const downloadsHeader = downloadsHtml.match(headerPattern)?.[0];

  assert.ok(landingHeader);
  assert.equal(downloadsHeader, landingHeader);
  assert.match(siteCss, /\.public-body \.masthead \{/);
  assert.doesNotMatch(downloadsHeader, /Overview|Quickstart|__LILAC_/);
});
