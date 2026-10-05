import { DESKTOP_MIN_WIDTH, layoutFor, TABLET_MIN_WIDTH } from './layout';

describe('layoutFor', () => {
  it('is a phone below 640', () => {
    expect(layoutFor(0)).toBe('phone');
    expect(layoutFor(390)).toBe('phone');
    expect(layoutFor(639)).toBe('phone');
    expect(layoutFor(639.5)).toBe('phone');
  });

  it('is a tablet from 640 up to 1023', () => {
    expect(layoutFor(640)).toBe('tablet');
    expect(layoutFor(834)).toBe('tablet');
    expect(layoutFor(1023)).toBe('tablet');
  });

  it('is a desktop from 1024', () => {
    expect(layoutFor(1024)).toBe('desktop');
    expect(layoutFor(1440)).toBe('desktop');
  });

  it('exports the thresholds it uses', () => {
    expect(layoutFor(TABLET_MIN_WIDTH - 1)).toBe('phone');
    expect(layoutFor(TABLET_MIN_WIDTH)).toBe('tablet');
    expect(layoutFor(DESKTOP_MIN_WIDTH - 1)).toBe('tablet');
    expect(layoutFor(DESKTOP_MIN_WIDTH)).toBe('desktop');
  });
});
