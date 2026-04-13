import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { OnboardingProgressPanel } from '@/components/dashboard/panels/OnboardingProgressPanel';

afterEach(cleanup);

function makeSteps(total: number, completedCount: number) {
  return Array.from({ length: total }, (_, i) => ({
    id: `step-${i}`,
    label: `Step ${i + 1}`,
    description: `Description ${i + 1}`,
    completed: i < completedCount,
  }));
}

describe('OnboardingProgressPanel, HeroUI ProgressBar', () => {
  it('renders a progressbar role element', () => {
    render(<OnboardingProgressPanel steps={makeSteps(4, 2)} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('sets aria-valuemax to 100 (HeroUI percentage scale)', () => {
    render(<OnboardingProgressPanel steps={makeSteps(4, 2)} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '100');
  });

  it('sets aria-valuenow to the percentage (not the raw count)', () => {
    // 2 of 4 steps = 50%
    render(<OnboardingProgressPanel steps={makeSteps(4, 2)} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('sets aria-valuenow to 100 when all steps are complete', () => {
    render(<OnboardingProgressPanel steps={makeSteps(3, 3)} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('sets aria-valuenow to 0 when no steps are complete', () => {
    render(<OnboardingProgressPanel steps={makeSteps(3, 0)} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('carries an accessible label with step counts', () => {
    render(<OnboardingProgressPanel steps={makeSteps(4, 1)} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', '1 of 4 steps complete');
  });
});
