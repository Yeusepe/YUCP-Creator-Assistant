import { describe, expect, it } from 'bun:test';
import { parseVpmRepositoryIndex } from './vpmRepository';

describe('VPM repository parser', () => {
  it('accepts a bounded established repository with more than 256 releases', () => {
    const versions = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => {
        const version = `1.${index}.0`;
        return [
          version,
          {
            name: 'com.example.established',
            version,
            url: `https://packages.example.test/established-${version}.zip`,
          },
        ];
      })
    );

    const parsed = parseVpmRepositoryIndex({
      packages: {
        'com.example.established': { versions },
      },
    });

    expect(Object.keys(parsed.packages['com.example.established']?.versions ?? {})).toHaveLength(
      300
    );
  });
});
