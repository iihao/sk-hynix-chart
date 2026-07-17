import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderConnectionState,
  renderFactors,
  renderSignals,
  renderSourceHealth,
} from '../public/js/dashboard-renderers.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.className = '';
    this.textContent = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  get firstChild() { return this.children[0] || null; }
}
const document = { createElement: (tag) => new Element(tag) };

test('renders external factor labels as text', () => {
  const root = new Element();
  renderFactors(document, root, [{label: '<img src=x>', detail: 'safe', score: 1.2}]);
  assert.equal(root.children[0].children[0].textContent, '<img src=x>');
  assert.equal(root.children[0].children[2].textContent, '+1.2');
});

test('renders an explicit empty signal state', () => {
  const root = new Element();
  renderSignals(document, root, []);
  assert.equal(root.children[0].textContent, '暂无信号');
});

test('renders source ages and connection state', () => {
  const root = new Element();
  renderSourceHealth(document, root, {naver: {count: 2, latest: {ts: 90}}}, 100000);
  assert.equal(root.children[0].children[1].textContent, '2 ticks');
  assert.equal(root.children[0].children[2].textContent, '10s');
  const label = new Element();
  renderConnectionState(label, 'live');
  assert.equal(label.textContent, 'LIVE');
  assert.match(label.className, /connection-live/);
});
