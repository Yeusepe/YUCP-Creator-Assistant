const PRIMARY_COLOR = '#8fbffa';
const ACCENT_COLOR = '#2859c5';
const ACCENT_OPACITY = '0.6';
const ALLOWED_ELEMENTS = new Set(['desc', 'g', 'path', 'svg']);
const ALLOWED_ATTRIBUTES = {
  desc: new Set<string>(),
  g: new Set(['id']),
  path: new Set(['clip-rule', 'd', 'fill', 'fill-opacity', 'fill-rule', 'id', 'stroke-width']),
  svg: new Set(['fill', 'id', 'viewBox', 'xmlns']),
} as const;

export type GeneratedIconData = {
  body: string;
  viewBox: string;
};

function replaceFill(tag: string, sourceColor: string, opacity?: string): string {
  let transformed = tag.replace(
    new RegExp(`\\bfill\\s*=\\s*(["'])${sourceColor}\\1`, 'i'),
    'fill="currentColor"'
  );
  const fillOpacityPattern = /\s+fill-opacity\s*=\s*(["'])[^"']*\1/i;

  if (!opacity) {
    return transformed.replace(fillOpacityPattern, '');
  }
  if (fillOpacityPattern.test(transformed)) {
    return transformed.replace(fillOpacityPattern, ` fill-opacity="${opacity}"`);
  }
  transformed = transformed.replace(/\s*(\/?)>$/, ` fill-opacity="${opacity}"$1>`);
  return transformed;
}

function assertAllowedAttributes(
  element: keyof typeof ALLOWED_ATTRIBUTES,
  attributes: string,
  iconName: string
): void {
  const attributePattern = /\s+([\w:-]+)\s*=\s*(["'])[^"']*\2/g;
  const names = [...attributes.matchAll(attributePattern)].map((match) => match[1]);
  const unparsed = attributes.replace(attributePattern, '').replace('/', '').trim();
  if (unparsed) {
    throw new Error(`Icon "${iconName}" contains malformed <${element}> attributes`);
  }
  const unsupportedAttribute = names.find(
    (attribute) => attribute && !ALLOWED_ATTRIBUTES[element].has(attribute)
  );
  if (unsupportedAttribute) {
    throw new Error(
      `Icon "${iconName}" contains unsupported ${unsupportedAttribute} SVG attributes`
    );
  }
}

export function transformFlexFlatSvg(svg: string, iconName = 'unknown'): GeneratedIconData {
  const rootMatch = svg.match(/^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i);
  if (!rootMatch) {
    throw new Error(`Icon "${iconName}" is not a complete SVG document`);
  }

  const unsupportedElement = [...svg.matchAll(/<\/?\s*([a-z][\w:-]*)\b/gi)]
    .map((match) => match[1]?.toLowerCase())
    .find((element) => element && !ALLOWED_ELEMENTS.has(element));
  if (unsupportedElement) {
    throw new Error(`Icon "${iconName}" contains unsupported <${unsupportedElement}> markup`);
  }
  if (/\bon[a-z]+\s*=|\bhref\s*=/i.test(svg)) {
    throw new Error(`Icon "${iconName}" contains unsafe interactive SVG attributes`);
  }
  if (!/<desc>[\s\S]*streamline[\s\S]*<\/desc>/i.test(svg)) {
    throw new Error(`Icon "${iconName}" is missing its Streamline attribution description`);
  }

  const rootAttributes = rootMatch[1] ?? '';
  const body = rootMatch[2] ?? '';
  assertAllowedAttributes('svg', rootAttributes, iconName);
  for (const elementMatch of body.matchAll(/<(desc|g|path)\b([^>]*)>/gi)) {
    const element = elementMatch[1]?.toLowerCase() as keyof typeof ALLOWED_ATTRIBUTES;
    assertAllowedAttributes(element, elementMatch[2] ?? '', iconName);
  }
  const viewBox = rootAttributes.match(/\bviewBox\s*=\s*(["'])([^"']+)\1/i)?.[2];
  if (viewBox !== '0 0 14 14') {
    throw new Error(`Icon "${iconName}" has an unexpected viewBox`);
  }

  const unknownColor = [...svg.matchAll(/#[0-9a-f]{6}\b/gi)]
    .map((match) => match[0].toLowerCase())
    .find((color) => color !== PRIMARY_COLOR && color !== ACCENT_COLOR);
  if (unknownColor) {
    throw new Error(`Icon "${iconName}" contains an unsupported source color`);
  }

  let transformedPathCount = 0;
  const transformedBody = body.replace(/<path\b[^>]*>/gi, (tag) => {
    if (new RegExp(`\\bfill\\s*=\\s*(["'])${PRIMARY_COLOR}\\1`, 'i').test(tag)) {
      transformedPathCount += 1;
      return replaceFill(tag, PRIMARY_COLOR);
    }
    if (new RegExp(`\\bfill\\s*=\\s*(["'])${ACCENT_COLOR}\\1`, 'i').test(tag)) {
      transformedPathCount += 1;
      return replaceFill(tag, ACCENT_COLOR, ACCENT_OPACITY);
    }
    throw new Error(`Icon "${iconName}" contains a path without a supported fill color`);
  });

  if (transformedPathCount === 0) {
    throw new Error(`Icon "${iconName}" contains no transformable paths`);
  }
  if (/#8fbffa|#2859c5/i.test(transformedBody) || !/currentColor/.test(transformedBody)) {
    throw new Error(`Icon "${iconName}" did not complete the currentColor transform`);
  }

  return { body: transformedBody.trim(), viewBox };
}
