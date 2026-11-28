import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Command } from 'cmdk';
import { type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type Ref, type RefObject } from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';
import 'sonner/dist/styles.css';
import { useScheme } from './scheme';

/** The primitives screens build on: Radix for behaviour and focus handling, tokens for looks. Every control needs an accessible name. */
/** The look of a button: the accent for the one action of a screen, `destructive` for one that loses something (DESIGN.md "The system": `--danger` and `--on-danger`). */
export type ButtonVariant = 'primary' | 'destructive';

export function Button({ variant, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type="button" data-variant={variant} {...rest} />;
}

/**
 * A confirmation of something that cannot be taken back. Its verb is `destructive` by default (and by type: a new call site cannot get the accent silently), and
 * Cancel keeps the first place, so the hand falls on it first. The destructive button is never focused.
 */
/** `returnFocus`: the element that gets the focus when the dialog closes (the default is the element that had it before: gone, when the dialog was opened by choosing an item of a menu). */
export function Modal({ title, open, onOpenChange, children, returnFocus }: { title: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode; returnFocus?: RefObject<HTMLElement | null> }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="modal"
          aria-describedby={undefined}
          {...(returnFocus === undefined ? {} : { onCloseAutoFocus: (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); } })}
        >
          <Dialog.Title>{title}</Dialog.Title>
          {children}
          <Dialog.Close asChild>
            <Button>Close</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A confirmation that cannot be dismissed by accident: for destructive actions (delete, purge). */
export function Confirm({
  title,
  description,
  confirmLabel,
  open,
  onOpenChange,
  onConfirm,
  confirmVariant = 'destructive',
}: {
  title: string;
  description: string;
  confirmLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** `primary` only where the action loses nothing (a reset with no replacement text): `destructive` (the default) fills with `--danger`. */
  confirmVariant?: ButtonVariant;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="modal">
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
          <AlertDialog.Cancel asChild>
            <Button>Cancel</Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action asChild>
            <Button variant={confirmVariant} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </AlertDialog.Action>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export interface MenuItem {
  readonly label: string;
  readonly onSelect: () => void;
}
/** A menu of actions behind one button: `label` names the button for a screen reader, and `text` (it should be part of `label`) or `icon` is what the button shows instead of the dots. */
export function Menu({ label, items, text, icon, triggerRef }: { label: string; items: readonly MenuItem[]; text?: string; icon?: ReactNode; triggerRef?: Ref<HTMLButtonElement> }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" ref={triggerRef} aria-label={label} title={icon === undefined ? undefined : label}>
          {icon ?? text ?? '…'}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end">
          {items.map((item) => (
            <DropdownMenu.Item key={item.label} className="menu-item" onSelect={item.onSelect}>
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip">{text}</Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
}
/** One shortcut opens search, navigation and actions together (docs/design.md). */
export function CommandPalette({ open, onOpenChange, items }: { open: boolean; onOpenChange: (open: boolean) => void; items: readonly PaletteItem[] }) {
  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette" className="modal palette">
      <VisuallyHidden>
        <Dialog.Title>Command palette</Dialog.Title>
      </VisuallyHidden>
      <Command.Input placeholder="Search, go to, or do" />
      <Command.List>
        <Command.Empty>No results</Command.Empty>
        {items.map((item) => (
          <Command.Item
            key={item.id}
            value={item.label}
            onSelect={() => {
              item.onSelect();
              onOpenChange(false);
            }}
          >
            {item.label}
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}

/** The notices are painted with the tokens, so they follow the theme with the rest of the page; the library is told the scheme for the parts it draws itself. */
const NOTICE_TOKENS = { '--normal-bg': 'var(--paper-raised)', '--normal-text': 'var(--ink)', '--normal-border': 'var(--hairline)' } as CSSProperties;

/** Mount once, near the root. The wrapper's notices go through `notify`. */
export function Toaster() {
  const theme = useScheme();
  return <SonnerToaster position="bottom-right" closeButton theme={theme} style={NOTICE_TOKENS} toastOptions={{ style: { fontFamily: 'var(--font-ui)' } }} />;
}
export const notify = (text: string): void => {
  toast(text);
};
