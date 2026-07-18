import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/signal-panel.css', import.meta.url), 'utf8');

test('keeps the right signal panel visible when open on wide desktop', () => {
  const wideMedia = css.match(/@media\s*\(min-width:\s*1600px\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(wideMedia, /\.signal-panel[^{]*\{[\s\S]*translateX\(280px\)/);
  assert.match(wideMedia, /\.signal-panel\.open[^{]*\{[\s\S]*transform:\s*translateX\(0\)/);
});

test('hides the expand strip while the signal panel is open', () => {
  assert.match(css, /body\.signal-panel-open\s+\.signal-expand-strip\s*\{[^}]*display:\s*none/);
});
