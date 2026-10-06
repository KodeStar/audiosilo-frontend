import { isEditable, isModalOpen } from './keyboard';

const el = (tagName: string, isContentEditable = false) =>
  ({ tagName, isContentEditable }) as unknown as Element;

describe('isEditable', () => {
  it('is true for fields and editable content', () => {
    expect(isEditable(el('INPUT'))).toBe(true);
    expect(isEditable(el('TEXTAREA'))).toBe(true);
    expect(isEditable(el('SELECT'))).toBe(true);
    expect(isEditable(el('DIV', true))).toBe(true);
  });

  it('is false for anything else and for no focus', () => {
    expect(isEditable(el('BUTTON'))).toBe(false);
    expect(isEditable(el('DIV'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('isModalOpen', () => {
  it('looks for an aria-modal dialog', () => {
    const query = jest.fn((sel: string) =>
      sel === '[aria-modal="true"]' ? ({} as Element) : null,
    );
    expect(isModalOpen({ querySelector: query } as Pick<Document, 'querySelector'>)).toBe(true);
    expect(isModalOpen({ querySelector: () => null } as Pick<Document, 'querySelector'>)).toBe(
      false,
    );
  });
});
