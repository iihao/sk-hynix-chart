import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/signal-panel.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('keeps the right signal panel visible when open on wide desktop', () => {
  const wideMedia = css.match(/@media\s*\(min-width:\s*1600px\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(wideMedia, /\.signal-panel[^{]*\{[\s\S]*translateX\(280px\)/);
  assert.match(wideMedia, /\.signal-panel\.open[^{]*\{[\s\S]*transform:\s*translateX\(0\)/);
});

test('hides the expand strip while the signal panel is open', () => {
  assert.match(css, /body\.signal-panel-open\s+\.signal-expand-strip\s*\{[^}]*display:\s*none/);
});

test('wide mode keeps the existing 540px panel width', () => {
  assert.match(css, /body\.wide-mode\s+\.signal-panel\s*\{[^}]*width:\s*540px/);
});

test('signal panel uses explicit two-column containers for wide mode balancing', () => {
  const bodyIndex = html.indexOf('id="signalBody"');
  const leftIndex = html.indexOf('class="signal-column sb-col1"');
  const rightIndex = html.indexOf('class="signal-column sb-col2"');
  const directionIndex = html.indexOf('id="dirDashCollapsible"');
  const factorsIndex = html.indexOf('id="factorsCollapsible"');

  assert.notEqual(bodyIndex, -1);
  assert.ok(leftIndex > bodyIndex, 'left column should be inside signal body');
  assert.ok(rightIndex > leftIndex, 'right column should follow left column');
  assert.ok(directionIndex > leftIndex && directionIndex < rightIndex, 'direction dashboard should be in the left column');
  assert.ok(factorsIndex > rightIndex, 'factors should be in the right column');
});
