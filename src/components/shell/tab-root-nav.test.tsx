import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

let mockPathname = '/library';
let mockSegments = ['(app)', '(library)'];
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useSegments: () => mockSegments,
  useNavigationContainerRef: () => ({ dispatch: jest.fn() }),
  router: { navigate: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));

let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/downloads/engine', () => ({ engine: { supported: true } }));

/* eslint-disable import/first */
import { SubNav } from './sub-nav';
import { useSubNav } from './sub-nav-store';
import { SubNavActions, SubNavSections } from './tab-root-nav';
/* eslint-enable import/first */

const OPTIONS = [
  { value: 'books', label: 'Books' },
  { value: 'authors', label: 'Authors', count: 612 },
];

function Root({ onChange = jest.fn(), value = 'books' }: { onChange?: jest.Mock; value?: string }) {
  return (
    <>
      <SubNavSections
        tab="(library)"
        options={OPTIONS}
        value={value}
        onChange={onChange}
        accessibilityLabel="Browse by"
      />
      <SubNavActions tab="(library)" id="sort" order={1}>
        <Text>Sort</Text>
      </SubNavActions>
      <SubNavActions tab="(library)" id="picker" order={-1}>
        <Text>Picker</Text>
      </SubNavActions>
    </>
  );
}

describe('tab root sub-nav content', () => {
  beforeEach(() => {
    mockLayout = 'desktop';
    mockPathname = '/library';
    mockSegments = ['(app)', '(library)'];
    useSubNav.setState({ slots: {} });
  });

  it('publishes the sections and actions into the desktop sub-nav, in order', async () => {
    const onChange = jest.fn();
    await render(
      <>
        <SubNav />
        <Root onChange={onChange} />
      </>,
    );
    expect(screen.getByRole('header', { name: 'Library' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Books', checked: true })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Authors, 612' })).toBeTruthy();
    const texts = screen.getAllByText(/Sort|Picker/).map((n) => n.props.children);
    expect(texts).toEqual(['Picker', 'Sort']);

    await fireEvent.press(screen.getByRole('radio', { name: 'Authors, 612' }));
    expect(onChange).toHaveBeenCalledWith('authors');
  });

  it('drops the title on a tablet when there are sections', async () => {
    mockLayout = 'tablet';
    await render(
      <>
        <SubNav />
        <Root />
      </>,
    );
    expect(screen.queryByRole('header', { name: 'Library' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Books' })).toBeTruthy();
  });

  it('withdraws what a root published when it unmounts', async () => {
    const { rerender } = await render(
      <>
        <SubNav />
        <Root />
      </>,
    );
    expect(screen.getByText('Picker')).toBeTruthy();
    await rerender(<SubNav />);
    expect(screen.queryByText('Picker')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(useSubNav.getState().slots['(library)']).toEqual({ actions: [], sections: undefined });
  });

  it("shows only the active tab root's content", async () => {
    await render(<Root />);
    mockPathname = '/downloads';
    mockSegments = ['(app)', '(offline)'];
    await render(<SubNav />);
    expect(screen.queryByText('Picker')).toBeNull();
    expect(screen.getByRole('header', { name: 'Downloads' })).toBeTruthy();
  });

  it('renders the sections and actions in place on a phone, publishing nothing', async () => {
    mockLayout = 'phone';
    await render(<Root />);
    expect(screen.getByRole('radio', { name: 'Books', checked: true })).toBeTruthy();
    expect(screen.getByText('Picker')).toBeTruthy();
    await act(async () => {});
    expect(useSubNav.getState().slots['(library)']).toBeUndefined();
  });
});
