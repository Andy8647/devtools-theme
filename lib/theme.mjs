// Theme engine: turns a small theme description (roles + optional raw tokens)
// into the CSS that gets appended to DevTools' design_system_tokens.css.
//
// DevTools colours are a two-layer system:
//   ~150 semantic --sys-color-* tokens  ->  ~250 --ref-palette-<family><tone>
// The theme picks the ref palette (Material-style 0..100 tonal ramps); everything
// else follows. So a theme only has to provide:
//   neutral  : a few tonal anchors per variant (10..99 are the ones DevTools uses)
//   accents  : one brand colour per family; the ramps are generated
//   syntax   : the --sys-color-token-* set (inherits nothing useful by default)
// plus fonts. Raw overrides are the escape hatch when the maths reads wrong.

export const FAMILIES = [
  'primary', 'secondary', 'tertiary', 'error',
  'yellow', 'green', 'blue', 'cyan', 'orange', 'purple', 'pink', 'indigo',
];

export const TONES = [0, 10, 15, 20, 25, 30, 35, 40, 50, 55, 60, 70, 80, 90, 94, 95, 98, 99, 100];

// Which accent family each syntax token falls back to when the theme does not
// name it explicitly.
const SYNTAX_FALLBACK = {
  'variable': 'neutral80',
  'variable-special': 'cyan',
  'property': 'blue',
  'property-special': 'pink',
  'type': 'blue',
  'definition': 'blue',
  'builtin': 'cyan',
  'keyword': 'tertiary',
  'number': 'orange',
  'string': 'green',
  'string-special': 'green',
  'atom': 'orange',
  'tag': 'error',
  'attribute': 'yellow',
  'attribute-value': 'green',
  'comment': 'neutral60',
  'meta': 'neutral70',
  'deleted': 'error',
  'inserted': 'green',
  'pseudo-element': 'cyan',
  'subtle': 'neutral60',
};

const hex = h => {
  const s = h.replace('#', '');
  const n = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
};

const toHex = v => '#' + v.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');

export const mix = (a, b, t) => {
  const [x, y] = [hex(a), hex(b)];
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
};

// Closest tone present in a sparse anchor table, and a piecewise-linear fill so
// a theme can ship 4 neutral anchors instead of 19.
function fillTones(anchors) {
  const known = Object.entries(anchors).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
  if (known.length < 2) throw new Error('neutral needs at least two tonal anchors');
  const out = {};
  // fill every integer 0..100 so callers can index shifted tones (t-10) too
  for (let t = 0; t <= 100; t++) {
    const exact = known.find(([k]) => k === t);
    if (exact) { out[t] = exact[1]; continue; }
    const lo = [...known].reverse().find(([k]) => k < t) ?? known[0];
    const hi = known.find(([k]) => k > t) ?? known[known.length - 1];
    out[t] = lo[0] === hi[0] ? lo[1] : mix(lo[1], hi[1], (t - lo[0]) / (hi[0] - lo[0]));
  }
  return out;
}

// tone 80 == brand in dark, tone 40 == brand in light: that is where DevTools
// reads --sys-color-primary from in each theme.
function darkRamp(brand, n) {
  const out = {};
  // fill every integer 0..100 so callers can index shifted tones (t-10) too
  for (let t = 0; t <= 100; t++) {
    if (t <= 80) out[t] = mix(n[0], brand, (t / 80) ** 0.85);
    else out[t] = mix(brand, n[95], ((t - 80) / 20) * 0.85);
  }
  return out;
}

function lightRamp(brand, n) {
  const out = {};
  // fill every integer 0..100 so callers can index shifted tones (t-10) too
  for (let t = 0; t <= 100; t++) {
    if (t <= 40) out[t] = mix(n[0], brand, (t / 40) ** 0.85);
    else if (t <= 80) out[t] = mix(brand, n[90], ((t - 40) / 40) * 0.75);
    else out[t] = mix(n[95], brand, Math.max(0.02, 0.06 - (t - 90) / 300));
  }
  return out;
}

function variantBlock(selector, variant, opts) {
  const n = fillTones(variant.neutral ?? {});
  const lines = [`${selector} {`];

  if (opts.label) lines.push(`  /* ${opts.label} */`);

  for (const t of TONES) lines.push(`  --ref-palette-neutral${t}: ${n[t]};`);

  // neutral-variant: same ladder, tinted toward the primary, and in dark one
  // step down so container surfaces recede instead of popping.
  const tint = variant.neutralVariantTint ?? (opts.dark ? 0.04 : 0.03);
  const shift = opts.dark ? 10 : 0;
  for (const t of TONES) lines.push(`  --ref-palette-neutral-variant${t}: ${mix(n[Math.max(0, t - shift)], variant.accents.primary, tint)};`);

  // secondary is a surface-ish family (dark --sys-color-base comes from tone 25)
  for (const t of TONES) lines.push(`  --ref-palette-secondary${t}: ${mix(n[Math.max(0, t - shift)], variant.accents.primary, opts.dark ? 0.025 : 0.10)};`);

  for (const fam of FAMILIES) {
    if (fam === 'secondary') continue;
    const brand = variant.accents[fam];
    if (!brand) continue;
    const ramp = opts.dark ? darkRamp(brand, n) : lightRamp(brand, n);
    for (const t of TONES) lines.push(`  --ref-palette-${fam}${t}: ${ramp[t]};`);
  }

  // surfaces: DevTools' embedded frontend always adds .baseline-default, whose
  // own block repoints surface/base at neutral100/neutral10. Override it.
  const s = variant.surfaces ?? {};
  if (s.surface) lines.push(`  --sys-color-surface: ${s.surface};`);
  if (s.container) lines.push(`  --sys-color-cdt-base-container: ${s.container};`);
  if (s.base) lines.push(`  --sys-color-base: ${s.base};`);
  if (s.baseContainer) lines.push(`  --sys-color-base-container: ${s.baseContainer};`);
  if (s.divider) lines.push(`  --sys-color-divider: ${s.divider};`);

  // syntax
  for (const [token, fallback] of Object.entries(SYNTAX_FALLBACK)) {
    const explicit = variant.syntax?.[token];
    let value = explicit;
    if (!value) {
      const m = /^neutral(\d+)$/.exec(fallback);
      value = m ? n[Number(m[1])] : (variant.accents[fallback] ?? n[60]);
    }
    lines.push(`  --sys-color-token-${token}: ${value};`);
  }

  for (const [k, v] of Object.entries(variant.raw ?? {})) {
    lines.push(`  ${k.startsWith('--') ? k : '--' + k}: ${v};`);
  }

  lines.push('}');
  return lines.join('\n');
}

/** Render a theme object into the CSS that gets appended to the token sheet. */
export function renderTheme(theme) {
  const {variants = {}, fonts = {}} = theme;
  const out = [];
  out.push(`/* ${theme.name ?? 'devtools theme'} — generated by devtools-theme; edit the theme file, not this */`);

  const mono = fonts.mono;
  const size = fonts.monoSize;
  if (mono || size) {
    // the platform-* classes out-specify a plain :root rule for the two size vars
    out.push([
      ':root,',
      ':root.platform-mac,',
      ':root.platform-linux,',
      ':root.platform-windows {',
      mono ? `  --monospace-font-family: '${mono}', monospace !important;` : '',
      mono ? `  --source-code-font-family: '${mono}', monospace !important;` : '',
      size ? `  --monospace-font-size: ${size}px;` : '',
      size ? `  --source-code-font-size: ${size}px;` : '',
      size ? `  --sys-typescale-monospace-size: ${size}px;` : '',
      '}',
    ].filter(Boolean).join('\n'));
  }

  if (variants.light) {
    out.push(variantBlock(':root', variants.light, {dark: false, label: 'light'}));
    out.push(variantBlock(':root.baseline-default', variants.light, {dark: false, label: 'light / baseline-default'}));
  }
  if (variants.dark) {
    out.push(variantBlock(':root.theme-with-dark-background', variants.dark, {dark: true, label: 'dark'}));
    out.push(variantBlock(':root.theme-with-dark-background.baseline-default', variants.dark, {dark: true, label: 'dark / baseline-default'}));
  }
  return out.join('\n\n') + '\n';
}
