import { act, render, screen } from '@testing-library/react-native';

import { useReachability } from '@/api/reachability';

import { OfflineBanner } from './offline-banner';

const SCOPED = 'Offline - changes sync when reconnected';
const SOME = 'Some servers offline';

beforeEach(() => useReachability.setState({ online: {} }));

describe('OfflineBanner', () => {
  it("speaks for the page's own server on a connection-scoped page", async () => {
    useReachability.setState({ online: { a: true, b: false } });
    await render(<OfflineBanner connectionId="a" />);
    expect(screen.queryByText(SCOPED)).toBeNull();
    await act(async () => useReachability.setState({ online: { a: false, b: false } }));
    expect(screen.getByText(SCOPED)).toBeTruthy();
  });

  it('says some servers are offline on an aggregated page', async () => {
    await render(<OfflineBanner />);
    expect(screen.queryByText(SOME)).toBeNull();
    await act(async () => useReachability.setState({ online: { b: false } }));
    expect(screen.getByText(SOME)).toBeTruthy();
  });
});
