import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Card-style row for account lists (licenses, OAuth grants, etc.).
 * Replaces flat `account-list-row` dividers with a scannable tile layout.
 */
export function AccountEntityCard({
  index,
  children,
}: Readonly<{
  index: number;
  children: ReactNode;
}>) {
  const rowDelay = Math.min(index * 0.05, 0.25);

  return (
    <motion.article
      className="account-entity-card"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: rowDelay, duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      {children}
    </motion.article>
  );
}
