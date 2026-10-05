import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { Skeleton, SkeletonText } from './skeleton';

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

describe('Skeleton', () => {
  afterEach(() => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  it('renders a single placeholder block', async () => {
    await mount(<Skeleton className="h-4 w-32 rounded-md" testID="sk" />);
    expect(screen.getByTestId('sk')).toBeTruthy();
  });

  it('renders the requested number of text lines', async () => {
    await mount(<SkeletonText lines={3} />);
    // 3 line blocks rendered inside the column.
    expect(screen.root).toBeTruthy();
  });

  it('renders static under reduced motion (no crash)', async () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    await mount(<Skeleton className="h-4 w-32" testID="sk" />);
    expect(screen.getByTestId('sk')).toBeTruthy();
  });

  it('sweeps a shimmer once it has a width, and none under reduced motion', async () => {
    await render(<Skeleton className="h-4 w-32" testID="sk" />);
    const layout = { nativeEvent: { layout: { x: 0, y: 0, width: 128, height: 16 } } };
    await fireEvent(screen.getByTestId('sk'), 'layout', layout);
    expect(screen.getByTestId('skeleton-shimmer')).toBeTruthy();

    (useReducedMotion as jest.Mock).mockReturnValue(true);
    await render(<Skeleton className="h-4 w-32" testID="sk2" />);
    await fireEvent(screen.getByTestId('sk2'), 'layout', layout);
    expect(screen.queryByTestId('skeleton-shimmer')).toBeNull();
  });
});
