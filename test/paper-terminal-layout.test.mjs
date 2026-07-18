import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('places the paper trading terminal directly below the chart area, not inside the signal panel', () => {
  const chartIndex = html.indexOf('<div class="chart-wrapper">');
  const terminalIndex = html.indexOf('id="paperTradingTerminal"');
  const signalIndex = html.indexOf('id="signalPanel"');

  assert.notEqual(chartIndex, -1);
  assert.notEqual(terminalIndex, -1);
  assert.notEqual(signalIndex, -1);
  assert.ok(terminalIndex > chartIndex, 'paper terminal should be after the chart wrapper');
  assert.ok(terminalIndex < signalIndex, 'paper terminal should be before the right signal panel');
});
