import { fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

import type { LabelOption } from './books-view';
import { LabelFilter } from './label-filter';

const OPTIONS: LabelOption[] = [
  { key: 'classics', name: 'Classics', count: 1 },
  { key: 'fantasy', name: 'Fantasy', count: 12 },
];

describe('LabelFilter', () => {
  it('names the filter until one is chosen, then opens the choices with their counts', async () => {
    const onChange = jest.fn();
    await mountWithPortal(
      <LabelFilter kind="genre" options={OPTIONS} loading={false} onChange={onChange} />,
    );
    const chip = screen.getByRole('button', { name: 'Genre' });
    await fireEvent.press(chip);
    expect(screen.getByRole('heading', { name: 'Genre' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Any genre' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Fantasy, 12' })).not.toBeChecked();
    await fireEvent.press(screen.getByRole('radio', { name: 'Fantasy, 12' }));
    expect(onChange).toHaveBeenCalledWith('Fantasy');
    // The choice closes the dialog.
    expect(screen.queryByRole('radio', { name: 'Any genre' })).toBeNull();
  });

  it("shows the chosen label in the library's spelling, with its count, and drops it", async () => {
    const onChange = jest.fn();
    await mountWithPortal(
      <LabelFilter
        kind="tag"
        value="FANTASY"
        options={OPTIONS}
        loading={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Fantasy')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Tag: Fantasy, 12' }));
    expect(screen.getByRole('radio', { name: 'Fantasy, 12' })).toBeChecked();
    await fireEvent.press(screen.getByRole('radio', { name: 'Any tag' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('holds back the count while the library loads', async () => {
    await mountWithPortal(
      <LabelFilter kind="genre" value="Horror" options={[]} loading onChange={jest.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Genre: Horror' })).toBeTruthy();
  });
});
