import { cn } from './utils';

describe('cn', () => {
  it('joins conditional parts and drops falsy ones', () => {
    expect(cn('flex-row', false, null, undefined, 0, '', 'gap-2')).toBe('flex-row gap-2');
    expect(cn('p-4', { 'bg-primary': true, 'bg-white': false })).toBe('p-4 bg-primary');
    expect(cn(['rounded-lg', ['px-3', 'py-1.5']])).toBe('rounded-lg px-3 py-1.5');
  });

  it('lets the last conflicting class win', () => {
    expect(cn('items-center gap-3 px-6 py-12', 'py-6')).toBe('items-center gap-3 px-6 py-6');
    expect(cn('text-base text-gray-600', 'text-sm text-primary')).toBe('text-sm text-primary');
    expect(cn('bg-gray-100', 'bg-primary/10')).toBe('bg-primary/10');
  });

  it('keeps classes for different variants and properties', () => {
    expect(cn('text-gray-600 dark:text-gray-400', 'text-primary')).toBe(
      'dark:text-gray-400 text-primary',
    );
    expect(cn('active:opacity-80', 'opacity-50')).toBe('active:opacity-80 opacity-50');
    expect(cn('text-sm', 'text-danger-600')).toBe('text-sm text-danger-600');
  });

  it("understands this app's theme tokens", () => {
    // Custom font families are families, not weights.
    expect(cn('font-sans', 'font-roboto-medium')).toBe('font-roboto-medium');
    expect(cn('font-roboto-semibold', 'font-bold')).toBe('font-roboto-semibold font-bold');
    // Custom colour shades conflict like the default ones.
    expect(cn('bg-gray-840', 'bg-gray-750')).toBe('bg-gray-750');
    expect(cn('shadow-xs', 'dark:shadow-none')).toBe('shadow-xs dark:shadow-none');
  });
});
