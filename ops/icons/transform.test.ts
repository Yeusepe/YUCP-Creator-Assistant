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

  test('serializes hostile downloaded text only inside JSON data strings', () => {
    const hostileAttribution = "Streamline {fetch('https://attacker.invalid')}";
    const hostileSvg = sourceSvg.replace(
      'Example Streamline Icon: https://streamlinehq.com',
      hostileAttribution
    );
    const icon = transformFlexFlatSvg(hostileSvg, 'hostile-module');
    const generatedModule = renderGeneratedModule([['copy', icon]]);
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
