import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionCard } from '@/components/ui/SectionCard';

describe('SectionCard', () => {
  it('renders as a <section> element with section-card class', () => {
    render(<SectionCard>content</SectionCard>);
    const el = screen.getByText('content').closest('section');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass('section-card');
  });

  it('merges extra className onto root', () => {
    render(<SectionCard className="bento-col-6">content</SectionCard>);
    const el = screen.getByText('content').closest('section');
    expect(el).toHaveClass('section-card', 'bento-col-6');
  });

  it('Header renders as <header> with section-card__header class', () => {
    render(
      <SectionCard>
        <SectionCard.Header>My Header</SectionCard.Header>
      </SectionCard>
    );
    const header = screen.getByText('My Header').closest('header');
    expect(header).toBeInTheDocument();
    expect(header).toHaveClass('section-card__header');
  });

  it('Title defaults to h3 with section-card__title class', () => {
    render(
      <SectionCard>
        <SectionCard.Title>My Title</SectionCard.Title>
      </SectionCard>
    );
    const heading = screen.getByRole('heading', { name: 'My Title' });
    expect(heading.tagName).toBe('H3');
    expect(heading).toHaveClass('section-card__title');
  });

  it('Title can render as h2 via as prop', () => {
    render(
      <SectionCard>
        <SectionCard.Title as="h2">Heading 2</SectionCard.Title>
      </SectionCard>
    );
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('Content renders as div with section-card__content class', () => {
    render(
      <SectionCard>
        <SectionCard.Content>body</SectionCard.Content>
      </SectionCard>
    );
    const content = screen.getByText('body').closest('div');
    expect(content).toHaveClass('section-card__content');
  });

  it('Footer renders as <footer> with section-card__footer class', () => {
    render(
      <SectionCard>
        <SectionCard.Footer>footer text</SectionCard.Footer>
      </SectionCard>
    );
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveClass('section-card__footer');
  });
});
