import type { GeneratedIcon, GeneratedIconPath } from '../../apps/web/src/icons/types';

const PRIMARY_COLOR = '#8fbffa';
const ACCENT_COLOR = '#2859c5';
const ALLOWED_ELEMENTS = new Set(['desc', 'g', 'path', 'svg']);
const ALLOWED_BODY_ELEMENTS = new Set(['desc', 'g', 'path']);
const ALLOWED_ATTRIBUTES = {
  desc: new Set<string>(),
  g: new Set(['id']),
  path: new Set(['clip-rule', 'd', 'fill', 'fill-opacity', 'fill-rule', 'id', 'stroke-width']),
  svg: new Set(['fill', 'id', 'viewBox', 'xmlns']),
} as const;
const ALLOWED_FILL_RULES = new Set(['evenodd', 'inherit', 'nonzero']);
const SVG_PATH_DATA_PATTERN = /^[0-9MmLlHhVvCcSsQqTtAaZz\s,.+\-eE]+$/;

export type GeneratedIconData = GeneratedIcon;

type AllowedElement = keyof typeof ALLOWED_ATTRIBUTES;
type BodyElement = Exclude<AllowedElement, 'svg'>;
type FillRule = NonNullable<GeneratedIconPath['fillRule']>;

function parseAllowedAttributes(
  element: AllowedElement,
  attributes: string,
  iconName: string
): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>();
  const attributePattern = /\s+([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  let parsedThrough = 0;

  for (const match of attributes.matchAll(attributePattern)) {
    if (match.index !== parsedThrough) {
      throw new Error(`Icon "${iconName}" contains malformed <${element}> attributes`);
    }
    parsedThrough = (match.index ?? 0) + match[0].length;

    const name = match[1];
    const value = match[3];
    if (!name || value === undefined) {
      throw new Error(`Icon "${iconName}" contains malformed <${element}> attributes`);
    }
    if (!ALLOWED_ATTRIBUTES[element].has(name)) {
      throw new Error(`Icon "${iconName}" contains unsupported ${name} SVG attributes`);
    }
    if (parsed.has(name)) {
      throw new Error(`Icon "${iconName}" contains duplicate ${name} SVG attributes`);
    }
    parsed.set(name, value);
  }

  if (attributes.slice(parsedThrough).trim()) {
    throw new Error(`Icon "${iconName}" contains malformed <${element}> attributes`);
  }

  return parsed;
}

function parseFillRule(value: string | undefined, iconName: string): FillRule | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!ALLOWED_FILL_RULES.has(value)) {
    throw new Error(`Icon "${iconName}" contains an unsupported SVG fill rule`);
  }
  return value as FillRule;
}

function parsePath(attributes: ReadonlyMap<string, string>, iconName: string): GeneratedIconPath {
  const d = attributes.get('d');
  if (!d || !SVG_PATH_DATA_PATTERN.test(d)) {
    throw new Error(`Icon "${iconName}" contains invalid SVG path data`);
  }

  const fill = attributes.get('fill')?.toLowerCase();
  if (fill !== PRIMARY_COLOR && fill !== ACCENT_COLOR) {
    throw new Error(`Icon "${iconName}" contains a path without a supported fill color`);
  }

  const clipRule = parseFillRule(attributes.get('clip-rule'), iconName);
  const fillRule = parseFillRule(attributes.get('fill-rule'), iconName);
  const strokeWidth = attributes.get('stroke-width');

  return {
    ...(clipRule ? { clipRule } : {}),
    d,
    ...(fillRule ? { fillRule } : {}),
    ...(strokeWidth ? { strokeWidth } : {}),
    tone: fill === PRIMARY_COLOR ? 'primary' : 'secondary',
  };
}

function parseBody(
  body: string,
  iconName: string
): Pick<GeneratedIconData, 'attribution' | 'paths'> {
  const stack: BodyElement[] = [];
  const paths: GeneratedIconPath[] = [];
  const tagPattern = /<[^>]*>/g;
  let attribution: string | undefined;
  let cursor = 0;
  let descriptionText = '';

  const consumeText = (text: string): void => {
    if (stack.at(-1) === 'desc') {
      descriptionText += text;
    } else if (text.trim()) {
      throw new Error(`Icon "${iconName}" contains unexpected SVG text content`);
    }
  };

  for (const tagMatch of body.matchAll(tagPattern)) {
    const tagIndex = tagMatch.index ?? 0;
    consumeText(body.slice(cursor, tagIndex));
    const tag = tagMatch[0];
    cursor = tagIndex + tag.length;

    const closingMatch = tag.match(/^<\/\s*([a-z][\w:-]*)\s*>$/i);
    if (closingMatch) {
      const element = closingMatch[1]?.toLowerCase() as BodyElement;
      if (!ALLOWED_BODY_ELEMENTS.has(element) || stack.pop() !== element) {
        throw new Error(`Icon "${iconName}" contains malformed SVG element nesting`);
      }
      if (element === 'desc') {
        attribution = descriptionText.trim();
        descriptionText = '';
      }
      continue;
    }

    const openingMatch = tag.match(/^<\s*([a-z][\w:-]*)\b([\s\S]*?)(\/?)>$/i);
    if (!openingMatch) {
      throw new Error(`Icon "${iconName}" contains malformed SVG markup`);
    }

    const element = openingMatch[1]?.toLowerCase() as BodyElement;
    if (!ALLOWED_BODY_ELEMENTS.has(element)) {
      throw new Error(`Icon "${iconName}" contains malformed SVG body markup`);
    }
    if (stack.at(-1) === 'desc' || stack.at(-1) === 'path') {
      throw new Error(`Icon "${iconName}" contains invalid nested SVG markup`);
    }

    const attributes = parseAllowedAttributes(element, openingMatch[2] ?? '', iconName);
    const selfClosing = openingMatch[3] === '/';
    if (element === 'desc') {
      if (selfClosing || attribution !== undefined || stack.includes('desc')) {
        throw new Error(`Icon "${iconName}" contains an invalid attribution description`);
      }
      descriptionText = '';
    } else if (element === 'path') {
      paths.push(parsePath(attributes, iconName));
    }

    if (!selfClosing) {
      stack.push(element);
    }
  }

  consumeText(body.slice(cursor));
  if (stack.length > 0) {
    throw new Error(`Icon "${iconName}" contains unclosed SVG markup`);
  }
  if (!attribution || !/streamline/i.test(attribution)) {
    throw new Error(`Icon "${iconName}" is missing its Streamline attribution description`);
  }
  if (paths.length === 0) {
    throw new Error(`Icon "${iconName}" contains no transformable paths`);
  }

  return { attribution, paths };
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

  const rootAttributes = parseAllowedAttributes('svg', rootMatch[1] ?? '', iconName);
  const viewBox = rootAttributes.get('viewBox');
  if (viewBox !== '0 0 14 14') {
    throw new Error(`Icon "${iconName}" has an unexpected viewBox`);
  }

  const unknownColor = [...svg.matchAll(/#[0-9a-f]{6}\b/gi)]
    .map((match) => match[0].toLowerCase())
    .find((color) => color !== PRIMARY_COLOR && color !== ACCENT_COLOR);
  if (unknownColor) {
    throw new Error(`Icon "${iconName}" contains an unsupported source color`);
  }

  const parsedBody = parseBody(rootMatch[2] ?? '', iconName);
  return { ...parsedBody, viewBox };
}
