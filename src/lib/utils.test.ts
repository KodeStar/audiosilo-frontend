import { cn } from './utils';

describe('cn', () => {
  it('joins conditional parts and drops falsy ones', () => {
    expect(cn('flex-row', false, null, undefined, 0, '', 'gap-2')).toBe('flex-row gap-2');
    expect(cn('p-4', { 'bg-brand': true, 'bg-card': false })).toBe('p-4 bg-brand');
    expect(cn(['rounded-lg', ['px-3', 'py-1.5']])).toBe('rounded-lg px-3 py-1.5');
  });

  it('lets the last conflicting class win', () => {
    expect(cn('items-center gap-3 px-6 py-12', 'py-6')).toBe('items-center gap-3 px-6 py-6');
    expect(cn('text-base text-foreground', 'text-sm text-brand-ink')).toBe(
      'text-sm text-brand-ink',
    );
    expect(cn('bg-muted', 'bg-brand/10')).toBe('bg-brand/10');
  });

  it('keeps classes for different variants and properties', () => {
    expect(cn('text-foreground dark:text-white', 'text-brand-ink')).toBe(
      'dark:text-white text-brand-ink',
    );
    expect(cn('active:opacity-80', 'opacity-50')).toBe('active:opacity-80 opacity-50');
    expect(cn('text-sm', 'text-destructive')).toBe('text-sm text-destructive');
  });

  it('knows the Stacks radii and overlay shadow', () => {
    expect(cn('rounded-lg', 'rounded-control')).toBe('rounded-control');
    expect(cn('rounded-cover', 'rounded-full')).toBe('rounded-full');
    expect(cn('rounded-dialog', 'rounded-full')).toBe('rounded-full');
    expect(cn('shadow-xs', 'shadow-overlay')).toBe('shadow-overlay');
  });

  it("understands this app's theme tokens", () => {
    // Custom font families are families, not weights.
    expect(cn('font-sans', 'font-sans-medium')).toBe('font-sans-medium');
    expect(cn('font-display', 'font-sans-semibold')).toBe('font-sans-semibold');
    expect(cn('font-sans-semibold', 'font-bold')).toBe('font-sans-semibold font-bold');
    // Semantic colours conflict like the default ones, multi-word names included.
    expect(cn('bg-card', 'bg-muted')).toBe('bg-muted');
    expect(cn('border-border', 'border-border-strong')).toBe('border-border-strong');
    expect(cn('shadow-xs', 'dark:shadow-none')).toBe('shadow-xs dark:shadow-none');
  });

  it("merges a <Text> variant with this app's custom font and colour classes", () => {
    // The font tokens replace each other (and font-sans), never a weight.
    expect(cn('font-display-semibold text-xl', 'font-sans-medium')).toBe(
      'text-xl font-sans-medium',
    );
    expect(cn('font-mono text-xs', 'font-sans')).toBe('text-xs font-sans');
    // Semantic colours are text COLOURS, so they replace the variant's colour but keep
    // its size (and an arbitrary size replaces the size, not the colour).
    expect(cn('text-base text-foreground', 'text-destructive')).toBe('text-base text-destructive');
    expect(cn('text-xs text-muted-foreground', 'text-subtle-foreground')).toBe(
      'text-xs text-subtle-foreground',
    );
    expect(cn('text-xs text-muted-foreground', 'text-[10px]')).toBe(
      'text-muted-foreground text-[10px]',
    );
    expect(cn('text-sm text-foreground', 'text-brand-foreground')).toBe(
      'text-sm text-brand-foreground',
    );
  });
});
