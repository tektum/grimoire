import { Title } from '@radix-ui/react-dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { ReactNode } from 'react';

/** The title of the dialog, for a screen reader only (the palette has no visible title: its input is the thing to read). */
export function VisuallyHiddenText({ children }: { children: ReactNode }) {
  return (
    <VisuallyHidden>
      <Title>{children}</Title>
    </VisuallyHidden>
  );
}
