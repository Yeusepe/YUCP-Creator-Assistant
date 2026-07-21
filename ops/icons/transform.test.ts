import { describe, expect, test } from 'bun:test';
import { renderGeneratedModule } from './renderGeneratedModule';
import { transformFlexFlatSvg } from './transform';

const sourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 14">
  <desc>Example Streamline Icon: https://streamlinehq.com</desc>
  <path fill="#8fbffa" d="M0 0h7v7H0z" />
  <path fill="#2859c5" d="M7 7h7v7H7z" />
</svg>`;

describe('Flex Flat SVG transform', () => {
  test('preserves attribution and converts both source colors', () => {
    const transformed = transformFlexFlatSvg(sourceSvg, 'example');

    expect(transformed.viewBox).toBe('0 0 14 14');
    expect(transformed.attribution).toBe('Example Streamline Icon: https://streamlinehq.com');
    expect(transformed.paths).toEqual([
      { d: 'M0 0h7v7H0z' },
      { d: 'M7 7h7v7H7z', fillOpacity: '0.6' },
    ]);
    expect(JSON.stringify(transformed)).not.toMatch(/#8fbffa|#2859c5/i);
  });

  test('rejects markup that could execute in the browser', () => {
    const unsafeSvg = sourceSvg.replace(
      '</svg>',
      '<script>throw new Error("unsafe")</script></svg>'
    );

    expect(() => transformFlexFlatSvg(unsafeSvg, 'unsafe')).toThrow(
      'contains unsupported <script> markup'
    );
  });

  test('keeps hostile attribution text as data instead of generated JSX source', () => {
    const hostileAttribution = "Streamline {fetch('https://attacker.invalid')}";
    const hostileSvg = sourceSvg.replace(
      'Example Streamline Icon: https://streamlinehq.com',
      hostileAttribution
    );

    expect(transformFlexFlatSvg(hostileSvg, 'hostile-attribution')).toEqual({
      attribution: hostileAttribution,
      paths: [{ d: 'M0 0h7v7H0z' }, { d: 'M7 7h7v7H7z', fillOpacity: '0.6' }],
      viewBox: '0 0 14 14',
    });
  });

  test('rejects path data outside the strict SVG path grammar', () => {
    const hostileSvg = sourceSvg.replace('M0 0h7v7H0z', 'M0 0h7v7H0z{fetch}');

    expect(() => transformFlexFlatSvg(hostileSvg, 'hostile-path')).toThrow(
      'contains invalid SVG path data'
    );
  });

  test('rejects unsupported SVG attributes', () => {
    const unsupportedAttributeSvg = sourceSvg.replace(
      '<path fill="#8fbffa"',
      '<path aria-label="unsafe" fill="#8fbffa"'
    );

    expect(() => transformFlexFlatSvg(unsupportedAttributeSvg, 'unsupported-attribute')).toThrow(
      'contains unsupported aria-label SVG attributes'
    );
  });

  test('rejects duplicate SVG attributes', () => {
    const duplicateAttributeSvg = sourceSvg.replace(
      '<path fill="#8fbffa"',
      '<path fill="#8fbffa" fill="#8fbffa"'
    );

    expect(() => transformFlexFlatSvg(duplicateAttributeSvg, 'duplicate-attribute')).toThrow(
      'contains duplicate fill SVG attributes'
    );
  });

  test('rejects an unexpected viewBox', () => {
    const unexpectedViewBoxSvg = sourceSvg.replace('viewBox="0 0 14 14"', 'viewBox="0 0 24 24"');

    expect(() => transformFlexFlatSvg(unexpectedViewBoxSvg, 'unexpected-viewbox')).toThrow(
      'has an unexpected viewBox'
    );
  });

  test('rejects unsupported source colors', () => {
    const unsupportedColorSvg = sourceSvg.replace('#8fbffa', '#123456');

    expect(() => transformFlexFlatSvg(unsupportedColorSvg, 'unsupported-color')).toThrow(
      'contains an unsupported source color'
    );
  });

  test('rejects malformed SVG element nesting', () => {
    const malformedNestingSvg = sourceSvg.replace(
      '<path fill="#8fbffa" d="M0 0h7v7H0z" />',
      '<g><path fill="#8fbffa" d="M0 0h7v7H0z"></g></path>'
    );

    expect(() => transformFlexFlatSvg(malformedNestingSvg, 'malformed-nesting')).toThrow(
      'contains malformed SVG element nesting'
    );
  });

  test('serializes hostile downloaded text only inside JSON data strings', () => {
    const hostileAttribution = "Streamline {fetch('https://attacker.invalid')}";
    const hostileSvg = sourceSvg.replace(
      'Example Streamline Icon: https://streamlinehq.com',
      hostileAttribution
    );
    const icon = transformFlexFlatSvg(hostileSvg, 'hostile-module');
    const generatedModule = renderGeneratedModule([['copy', icon]], '0'.repeat(64));
    const assignment = 'export const generatedIcons: Record<IconName, GeneratedIcon> = ';
    const serializedData = generatedModule.slice(
      generatedModule.indexOf(assignment) + assignment.length,
      -2
    );

    expect(JSON.parse(serializedData)).toEqual({ copy: icon });
    expect(generatedModule).not.toContain('<desc>');
    expect(generatedModule).not.toContain('render:');
    expect(generatedModule).toContain(`"attribution": ${JSON.stringify(hostileAttribution)}`);
  });
});
