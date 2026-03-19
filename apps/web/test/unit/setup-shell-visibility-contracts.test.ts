import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const jinxxySetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/jinxxy.tsx'),
  'utf8'
);
const lemonSqueezySetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/lemonsqueezy.tsx'),
  'utf8'
);

describe('setup shell visibility contracts', () => {
  it('does not server-render the Jinxxy setup shell hidden by default', () => {
    expect(jinxxySetupSource).toContain('const [isVisible, setIsVisible] = useState(true);');
    expect(jinxxySetupSource).not.toContain("style={!isVisible ? { opacity: 0 } : undefined}");
  });

  it('does not server-render the Lemon Squeezy setup shell hidden by default', () => {
    expect(lemonSqueezySetupSource).toContain('const [isVisible, setIsVisible] = useState(true);');
  });
});
