/**
 * @jest-environment jsdom
 */

// A real DOM, so `isModalOpen` runs its selector against real attributes.
import { isEditable, isModalOpen, ownsArrows, ownsSpace } from './keyboard';

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
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** A `<div>` with these attributes, on the page. */
  const layer = (attributes: Record<string, string>) => {
    const div = document.createElement('div');
    for (const [name, value] of Object.entries(attributes)) div.setAttribute(name, value);
    document.body.appendChild(div);
    return div;
  };

  it('is false with no layer open', () => {
    layer({ role: 'region' });
    expect(isModalOpen(document)).toBe(false);
  });

  it('counts an aria-modal dialog (the bottom sheet)', () => {
    layer({ role: 'dialog', 'aria-modal': 'true' });
    expect(isModalOpen(document)).toBe(true);
  });

  it.each(['dialog', 'alertdialog', 'menu', 'listbox'])(
    'counts an open Radix %s, which sets no aria-modal',
    (role) => {
      layer({ role, 'data-state': 'open' });
      expect(isModalOpen(document)).toBe(true);
    },
  );

  it('does not count a closed layer, nor an open control that is not a layer', () => {
    const dialog = layer({ role: 'dialog', 'data-state': 'closed' });
    layer({ role: 'menu', 'data-state': 'closed' });
    // A Select's trigger while its list is open, a picked tab.
    layer({ role: 'combobox', 'data-state': 'open' });
    layer({ role: 'tab', 'data-state': 'active' });
    expect(isModalOpen(document)).toBe(false);
    dialog.setAttribute('data-state', 'open');
    expect(isModalOpen(document)).toBe(true);
  });
});

describe('ownsSpace and ownsArrows', () => {
  const node = (tagName: string, role?: string) => {
    const n = document.createElement(tagName);
    if (role) n.setAttribute('role', role);
    return n;
  };

  it('leaves Space to a button or link, and the arrows to the shortcuts', () => {
    for (const control of [
      node('button'),
      node('a'),
      node('div', 'button'),
      node('div', 'link'),
      node('div', 'checkbox'),
      node('div', 'switch'),
    ]) {
      expect(ownsSpace(control)).toBe(true);
      expect(ownsArrows(control)).toBe(false);
    }
  });

  it('leaves the arrows to a slider, and Space to the shortcuts', () => {
    for (const control of [
      node('div', 'slider'),
      node('div', 'spinbutton'),
      node('div', 'separator'),
    ]) {
      expect(ownsArrows(control)).toBe(true);
      expect(ownsSpace(control)).toBe(false);
    }
  });

  it('leaves both to controls Space picks and the arrows walk', () => {
    for (const role of [
      'tab',
      'radio',
      'option',
      'menuitem',
      'menuitemradio',
      'combobox',
      'listbox',
    ]) {
      expect(ownsSpace(node('div', role))).toBe(true);
      expect(ownsArrows(node('div', role))).toBe(true);
    }
  });

  it('leaves neither to plain elements or no focus', () => {
    for (const plain of [node('div'), node('body'), node('div', 'region'), null]) {
      expect(ownsSpace(plain)).toBe(false);
      expect(ownsArrows(plain)).toBe(false);
    }
  });
});
