import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'dist', 'integration.css'), 'utf8');

function declarations(source) {
  return Object.fromEntries(source.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const colon = entry.indexOf(':');
    assert.ok(colon > 0, `Invalid CSS declaration: ${entry}`);
    return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()];
  }));
}

const rootRules = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
assert.ok(rootRules.length, 'integration.css must define the gallery palette in :root');
const palette = declarations(rootRules.at(-1)[1]);

function rgb(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `Expected a six-digit color, received ${hex}`);
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function luminance(hex) {
  const linear = rgb(hex).map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function lab(hex) {
  const [red, green, blue] = rgb(hex).map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  const convert = (value) => value > 0.008856 ? value ** (1 / 3) : 7.787 * value + 16 / 116;
  const x = convert((0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047);
  const y = convert(0.2126 * red + 0.7152 * green + 0.0722 * blue);
  const z = convert((0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function colorDistance(first, second) {
  const firstLab = lab(first), secondLab = lab(second);
  return Math.sqrt(firstLab.reduce((sum, value, index) => sum + (value - secondLab[index]) ** 2, 0));
}

const required = ['--ink', '--red', '--muted', '--soft', '--coral', '--celadon', '--ochre', '--cream', '--frame'];
for (const token of required) assert.ok(palette[token], `Missing palette token ${token}`);
assert.equal(palette['--paper'], palette['--cream'], 'paper and cream must remain the same quiet canvas');

const surfaces = ['--coral', '--celadon', '--ochre', '--cream'];
for (const surface of surfaces) {
  assert.ok(contrast(palette['--ink'], palette[surface]) >= 4.5,
    `Ink text must reach 4.5:1 on ${surface}; received ${contrast(palette['--ink'], palette[surface]).toFixed(2)}:1`);
  assert.ok(contrast(palette['--frame'], palette[surface]) >= 3,
    `The gallery frame must reach 3:1 against ${surface}; received ${contrast(palette['--frame'], palette[surface]).toFixed(2)}:1`);
}

assert.ok(contrast(palette['--cream'], palette['--red']) >= 4.5,
  'Cream hover text must reach 4.5:1 against the brand red');
for (const quietSurface of ['--cream', '--soft']) {
  assert.ok(contrast(palette['--muted'], palette[quietSurface]) >= 4.5,
    `Muted supporting text must reach 4.5:1 on ${quietSurface}`);
}

for (let first = 0; first < surfaces.length; first += 1) {
  for (let second = first + 1; second < surfaces.length; second += 1) {
    const distance = colorDistance(palette[surfaces[first]], palette[surfaces[second]]);
    assert.ok(distance >= 20,
      `${surfaces[first]} and ${surfaces[second]} must remain visibly distinct; CIE76 distance was ${distance.toFixed(1)}`);
  }
}

function finalProperty(selector, property) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let value;
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].split(',').map((part) => part.trim()).includes(selector)) continue;
    const properties = declarations(rule[2]);
    if (properties[property]) value = properties[property];
  }
  return value;
}

for (const selector of ['.form-chapter .object-tag', '.form-chapter .object-tag span', '.form-chapter .card-dimensions', '.form-chapter .previous-price']) {
  assert.equal(finalProperty(selector, 'color'), 'var(--ink)', `${selector} must not inherit muted text on celadon`);
}
assert.equal(finalProperty('.photo-checklist small', 'color'), 'var(--ink)',
  'The small photo-checklist guidance must not use muted text on celadon');

console.log('Palette checks passed: readable text, 3:1 pastel framing, distinct neighboring hues, and colored-surface small-text overrides.');

assert.equal(finalProperty('.shop-sidebar .filter-group label', 'color'), 'var(--ink)', 'Small filter labels must stay readable against celadon');
