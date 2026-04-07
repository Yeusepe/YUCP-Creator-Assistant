import type { ReactNode } from 'react';

type SectionCardRootProps = {
  className?: string;
  children: ReactNode;
};

function SectionCardRoot({ className, children }: SectionCardRootProps) {
  return (
    <section className={['section-card', className].filter(Boolean).join(' ')}>{children}</section>
  );
}

type SectionCardHeaderProps = {
  className?: string;
  children: ReactNode;
};

function SectionCardHeader({ className, children }: SectionCardHeaderProps) {
  return (
    <header className={['section-card__header', className].filter(Boolean).join(' ')}>
      {children}
    </header>
  );
}

type SectionCardTitleProps = {
  className?: string;
  children: ReactNode;
  as?: 'h2' | 'h3' | 'h4';
};

function SectionCardTitle({ className, children, as: Tag = 'h3' }: SectionCardTitleProps) {
  return (
    <Tag className={['section-card__title', className].filter(Boolean).join(' ')}>{children}</Tag>
  );
}

type SectionCardDescriptionProps = {
  className?: string;
  children: ReactNode;
};

function SectionCardDescription({ className, children }: SectionCardDescriptionProps) {
  return (
    <p className={['section-card__description', className].filter(Boolean).join(' ')}>{children}</p>
  );
}

type SectionCardContentProps = {
  className?: string;
  children: ReactNode;
};

function SectionCardContent({ className, children }: SectionCardContentProps) {
  return (
    <div className={['section-card__content', className].filter(Boolean).join(' ')}>{children}</div>
  );
}

type SectionCardFooterProps = {
  className?: string;
  children: ReactNode;
};

function SectionCardFooter({ className, children }: SectionCardFooterProps) {
  return (
    <footer className={['section-card__footer', className].filter(Boolean).join(' ')}>
      {children}
    </footer>
  );
}

export const SectionCard = Object.assign(SectionCardRoot, {
  Header: SectionCardHeader,
  Title: SectionCardTitle,
  Description: SectionCardDescription,
  Content: SectionCardContent,
  Footer: SectionCardFooter,
});
