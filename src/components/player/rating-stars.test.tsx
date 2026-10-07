import { fireEvent, render, screen } from '@testing-library/react-native';

import { expectNativeTarget } from '@/testing/touch-target';

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import { RatingStars } from './rating-stars';
/* eslint-enable import/first */

it('rates the book with the star pressed, checking the saved rating', async () => {
  const onRate = jest.fn();
  await render(<RatingStars value={3} onRate={onRate} />);
  expect(screen.getByLabelText('3 stars')).toBeChecked();
  expect(screen.getByLabelText('4 stars')).not.toBeChecked();
  await fireEvent.press(screen.getByLabelText('5 stars'));
  expect(onRate).toHaveBeenCalledWith(5);
});

// STYLEGUIDE section 14: a star is `h-11 w-11`, 38.5 pt on native (a 14 pt rem).
it('gives each star a 44 pt target on native', async () => {
  await render(<RatingStars value={undefined} onRate={jest.fn()} />);
  for (const n of [1, 2, 3, 4, 5]) {
    expectNativeTarget(screen.getByLabelText(n === 1 ? '1 star' : `${n} stars`));
  }
});
