const fs = require('node:fs');
const path = require('node:path');

const fullCss = fs.readFileSync('full_styles.txt', 'utf8');

// Component-related selectors (from plan inventory)
const componentPatterns = [
  /\.section-card[\s\S]*?(?=\s*(?:\/\*|\.(?!section-card|platform-card|intg-card|oauth-app-card|quick-start)[a-z-]+|@media|$))/gi,
  /\.platform-card[\s\S]*?(?=\s*(?:\/\*|\.(?!platform-card)[a-z-][a-z0-9-]*\s|@media|$))/gi,
  /\.intg-card[\s\S]*?(?=\s*(?:\/\*[^*]*\*\/\s*\.(?!intg-card)[a-z]|\.(?!intg-card)[a-z-]+\s|@media|$))/gi,
  /\.oauth-app-card[\s\S]*?(?=\s*(?:\/\*|\.(?!oauth-app)[a-z-]+\s|@media|$))/gi,
  /\.dropdown-wrapper[\s\S]*?(?=\s*(?:\/\*|\.(?!dropdown|oauth-app-menu)[a-z-]+\s|@media|$))/gi,
  /\.dropdown-menu[\s\S]*?(?=\s*(?:\/\*|\.(?!dropdown|intg-card)[a-z-]+\s|@media|$))/gi,
  /\.status-pill[\s\S]*?(?=\s*(?:\/\*|\.(?!status-pill)[a-z-]+\s|@media|$))/gi,
  /\.card-action-btn[\s\S]*?(?=\s*(?:\/\*|\.(?!card-action)[a-z-]+\s|@media|$))/gi,
  /\.toggle-switch[\s\S]*?(?=\s*(?:\/\*|\.(?!toggle-switch|setting)[a-z-]+\s|@media|$))/gi,
  /\.empty-state[\s\S]*?(?=\s*(?:\/\*|\.(?!empty-state|intg-card)[a-z-]+\s|@media|$))/gi,
  /\.section-placeholder[\s\S]*?(?=\s*(?:\/\*|\.(?!section-placeholder)[a-z-]+\s|@media|$))/gi,
  /\.inline-panel[\s\S]*?(?=\s*(?:\/\*|\.(?!inline-panel|intg-card)[a-z-]+\s|@media|$))/gi,
  /\.panel-close-btn[\s\S]*?(?=\s*(?:\/\*|\.(?!panel-close|intg-card)[a-z-]+\s|@media|$))/gi,
  /\.modal-input[\s\S]*?(?=\s*(?:\/\*|\.(?!modal)[a-z-]+\s|@media|$))/gi,
  /\.scope-toggle[\s\S]*?(?=\s*(?=\s*(?:\/\*|\.(?!scope-toggle|intg-card)[a-z-]+\s|@media|$))/gi,
  /\.btn-primary[\s\S]*?(?=\s*(?:\/\*|\.(?!btn)[a-z-]+\s|@media|$))/gi,
  /\.btn-ghost[\s\S]*?(?=\s*(?=\s*(?:\/\*|\.(?!btn)[a-z-]+\s|@media|$))/gi,
];

// Simpler: split by comment blocks and rule groups
// Put everything in dashboard.css for now, extract components to dashboard-components.css
// We'll do a line-by-line parse

const lines = fullCss.split('\n');
const componentBlocks = [];
const layoutBlocks = [];

const currentBlock = [];
const inComponent = false;
const blockSelectors = '';

const componentSelectors = new Set([
  'section-card',
  'platform-card',
  'intg-card',
  'oauth-app-card',
  'quick-start-card',
  'quick-start-',
  'dropdown-wrapper',
  'dropdown-menu',
  'oauth-app-menu-btn',
  'server-dropdown',
  'status-pill',
  'card-action-btn',
  'toggle-switch',
  'empty-state',
  'section-placeholder',
  'inline-panel',
  'panel-close-btn',
  'modal-input',
  'modal-textarea',
  'modal-label',
  'modal-field',
  'modal-helper',
  'scope-toggle',
  'scope-toggle-card',
  'scope-toggle-check',
  'scope-toggle-text',
  'scope-toggle-name',
  'scope-toggle-desc',
  'btn-primary',
  'btn-ghost',
  'api-key-row',
  'api-key-icon',
  'api-key-prefix',
  'api-key-name',
  'oauth-app-icon',
  'oauth-app-icon-btn',
  'oauth-edit-body',
  'oauth-regen-body',
  'oauth-delete-body',
  'intg-icon',
  'intg-title',
  'intg-desc',
  'intg-add-btn',
  'intg-cred-box',
  'intg-cred',
]);

function blockIsComponent(lines) {
  const blockText = lines.join('\n');
  for (const sel of componentSelectors) {
    if (blockText.includes(`.${sel}`) || blockText.includes(`${sel} `)) return true;
  }
  return false;
}

// Parse into blocks (each rule or @media)
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  const trimmed = line.trim();

  if (
    trimmed.startsWith('/*') ||
    trimmed.startsWith('@keyframes') ||
    (trimmed.match(/^[.#a-zA-Z\[\]_-][\w\s,#.:()[\]-]*\{/) && !trimmed.startsWith('.dark'))
  ) {
    const blockStart = i;
    let braceCount = 0;
    const block = [line];
    i++;
    if (line.includes('{')) braceCount += (line.match(/\{/g) || []).length;
    if (line.includes('}')) braceCount -= (line.match(/\}/g) || []).length;

    while (i < lines.length && braceCount > 0) {
      block.push(lines[i]);
      if (lines[i].includes('{')) braceCount += (lines[i].match(/\{/g) || []).length;
      if (lines[i].includes('}')) braceCount -= (lines[i].match(/\}/g) || []).length;
      i++;
    }

    const blockStr = block.join('\n');
    const isDark = blockStr.includes('.dark ');
    const isComponent = !isDark && blockIsComponent(block);

    if (isDark) {
      layoutBlocks.push(block.join('\n'));
    } else if (isComponent) {
      componentBlocks.push(block.join('\n'));
    } else {
      layoutBlocks.push(block.join('\n'));
    }
    continue;
  }
  i++;
}

// Simpler approach: just put ALL in dashboard.css, create dashboard-components.css with ONLY the explicit component sections
// from the plan. We can refine later.
console.log('Blocks - component:', componentBlocks.length, 'layout:', layoutBlocks.length);
