import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';

const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
let checked = 0;

function inspect(path) {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) inspect(resolve(path, entry));
    return;
  }
  if (!/\.(svelte|css)$/.test(path)) return;
  const source = readFileSync(path, 'utf8');
  const cssOnly = path.endsWith('.css');
  const parsed = parse(cssOnly ? `<style>${source}</style>` : source);
  const offset = cssOnly ? 7 : 0;
  checked++;

  function report(node, message) {
    const line = source.slice(0, Math.max(0, node.start - offset)).split('\n').length;
    failures.push(`${relative(root, path)}:${line}: ${message}`);
  }

  function visit(nodes) {
    for (const node of nodes ?? []) {
      if (node.type === 'Rule') {
        const selectors = node.prelude.children.map(selector => source.slice(selector.start - offset, selector.end - offset));
        const selected = selectors.some(selector => /\.(on|active|selected|picked|hi|at)\b|\[aria-(selected|pressed|checked)\s*=\s*['"]?true/.test(selector) && !/:focus(?:-visible|-within)?\b/.test(selector));
        const control = selectors.some(selector => /(^|[ >+~])button\b|\.ui-tab\b/.test(selector));
        const tabbar = selectors.every(selector => /\.ui-tabs\s*>\s*\.ui-tab\b/.test(selector));
        const declarations = node.block.children.filter(child => child.type === 'Declaration');
        const style = Object.fromEntries(declarations.map(({ property, value }) => [property, value]));
        const thin = value => /^(?:[1-3](?:\.\d+)?|0?\.\d+)px$/.test(value ?? '');
        if (style.position === 'absolute' && ((/^0(?:px)?$/.test(style.bottom ?? '') && thin(style.height)) || (/^0(?:px)?$/.test(style.left ?? '') && thin(style.width))) && /var\(--(?:accent|buy|sell|warn)\)/.test(style.background ?? style['background-color'] ?? '')) report(node, 'Do not draw accent bars along a control edge; use the shared selected background.');
        for (const declaration of declarations) {
          const { property, value } = declaration;
          const clear = /^(0(?:px)?|none|transparent)(?:\s*!important)?$/.test(value.trim());
          if ((selected || control) && /^border-(bottom|left|block-end|inline-start)(-|$)/.test(property) && !clear) report(declaration, 'Controls use background and text contrast, never an edge border.');
          if ((selected || control) && property === 'box-shadow' && /inset/.test(value) && !(tabbar && /^inset\s+0(?:px)?\s+-1px\s+0(?:px)?\s+var\(--accent\)$/.test(value)) && !/^inset\s+0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+[\d.]+px\s+[^,]+$/.test(value)) report(declaration, 'Controls must not simulate edge highlights with inset shadows.');
          if ((selected || selectors.some(selector => /\.ui-tab\b/.test(selector))) && property.startsWith('text-decoration') && /underline/.test(value)) report(declaration, 'Selected controls must not use underlines.');
          if (selected && property === 'outline' && !clear) report(declaration, 'Reserve outlines for keyboard focus; use the shared selected background.');
          if (selected && /^(color|background(?:-color)?)$/.test(property) && /#[\da-f]{3,8}\b/i.test(value)) report(declaration, 'Use theme tokens for selected control colors.');
          if (selectors.some(selector => /\.num\b/.test(selector)) && ((property === 'overflow-wrap' && value === 'anywhere') || (property === 'word-break' && value === 'break-all'))) report(declaration, 'Numeric values must not break between digits.');
          if (property === 'transition' && /\ball\b/.test(value)) report(declaration, 'Name the transitioned properties; do not animate every layout change.');
        }
      }
      if (node.block) visit(node.block.children);
    }
  }
  visit(parsed.css?.children);
}

try {
  for (const path of process.argv.length > 2 ? process.argv.slice(2).map(path => resolve(path)) : [resolve(root, 'src')]) inspect(path);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Frontend design rules passed (${checked} Svelte/CSS files).`);
