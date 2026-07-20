import { describe, expect, test } from 'bun:test';
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
    expect(transformed.body).toContain('Example Streamline Icon');
    expect(transformed.body).not.toMatch(/#8fbffa|#2859c5/i);
    expect(transformed.body).toContain('fill="currentColor"');
    expect(transformed.body).toContain('fill-opacity="0.6"');
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
});
