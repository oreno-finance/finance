import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initPasswordFields, hidePasswordField, clearPasswordField } from '../dist/src/ui/password-fields.js';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../src/cloud/cloud-settings.ts', import.meta.url), 'utf8');

for (const id of ['vault-passphrase', 'vault-passphrase-confirm', 'cloud-current-secret']) {
  test(`${id}: paste-friendly input and visibility control exist`, () => {
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`, 'g'))?.[0];
    assert.ok(input, `${id} input is absent`);
    assert.match(input, /type="password"/);
    assert.match(input, /autocomplete="(?:new-password|current-password)"/);
    assert.doesNotMatch(input, /autocomplete="off"/);
    assert.match(html, new RegExp(`data-password-toggle="${id}"`));
  });
}

test('native password interactions preserve exact pasted characters, and clear resets reveal state', () => {
  const inputs = new Map();
  const toggles = [];
  class StubInput {
    constructor(id) { this.id = id; this.type = 'password'; this.value = ''; this.focused = false; }
    focus() { this.focused = true; }
  }
  class StubToggle {
    constructor(id, label) {
      this.dataset = { passwordToggle: id, passwordLabel: label };
      this.events = {};
      this.attributes = {};
      this.textContent = '表示';
    }
    addEventListener(event, callback) { this.events[event] = callback; }
    setAttribute(key, value) { this.attributes[key] = value; }
    click() { this.events.click(); }
  }
  const originalDocument = globalThis.document;
  const originalInput = globalThis.HTMLInputElement;
  try {
    globalThis.HTMLInputElement = StubInput;
    for (const [id, label] of [
      ['vault-passphrase', 'パスフレーズ'],
      ['vault-passphrase-confirm', '確認用パスフレーズ'],
      ['cloud-current-secret', 'パスフレーズ'],
    ]) {
      inputs.set(id, new StubInput(id));
      toggles.push(new StubToggle(id, label));
    }
    globalThis.document = {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-password-toggle]');
        return toggles;
      },
      getElementById(id) { return inputs.get(id); },
      querySelector(selector) { return toggles.find(t => selector === `[data-password-toggle="${t.dataset.passwordToggle}"]`); },
    };
    initPasswordFields();
    for (const [i, id] of [...inputs.keys()].entries()) {
      const field = inputs.get(id), toggle = toggles[i];
      const literal = `  🧩 abc\\DEF \tline\n${i} `;
      field.value = literal; // Clipboard/autofill supplies exact content; no input/paste interception.
      assert.deepEqual(Object.keys(field), ['id', 'type', 'value', 'focused']);
      toggle.click();
      assert.equal(field.type, 'text');
      assert.equal(field.value, literal);
      assert.equal(toggle.attributes['aria-pressed'], 'true');
      assert.equal(toggle.textContent, '隠す');
      assert.equal(field.focused, true);
      hidePasswordField(id);
      assert.equal(field.type, 'password');
      assert.equal(field.value, literal);
      clearPasswordField(id);
      assert.equal(field.value, '');
      assert.equal(toggle.attributes['aria-pressed'], 'false');
      assert.equal(toggle.textContent, '表示');
    }
  } finally {
    globalThis.document = originalDocument;
    globalThis.HTMLInputElement = originalInput;
  }
});

test('cloud vault dialog and diagnostic stay paste-friendly', () => {
  assert.match(main, /pass\.autocomplete=mode==='create'\?'new-password':'current-password'/);
  assert.match(main, /clearPasswordField\('vault-passphrase'\)/);
  assert.match(cloud, /clearPasswordField\('cloud-diagnostic-secret'\)/);
  assert.doesNotMatch(cloud, /uploadEncryptedProbe|downloadEncryptedProbe/);
  assert.doesNotMatch(cloud, /input\.value\s*=\s*''/);
});
