import { act, render, screen } from '@testing-library/react-native';

// Jest runs the native platform (no page): the web image reads a page at books.example.
const PAGE = { origin: 'https://books.example', href: 'https://books.example/web/' };
jest.mock('@/lib/cors-mode', () => {
  const actual = jest.requireActual('@/lib/cors-mode');
  return { corsModeFor: (url: string) => actual.corsModeFor(url, PAGE) };
});

/* eslint-disable import/first */
import { CoverImage } from './cover-image.web';
/* eslint-enable import/first */

type Img = { type: string; props: Record<string, unknown> };
const img = () => screen.toJSON() as unknown as Img;
/** Fire the `<img>`'s own handler (a DOM element: no host event plumbing in jest). */
const fire = (handler: 'onLoad' | 'onError') =>
  act(async () => (img().props[handler] as () => void)());

describe('CoverImage (web)', () => {
  it('loads another server’s cover in CORS mode', async () => {
    await render(<CoverImage source={{ uri: 'https://other.example/cover?token=k' }} />);
    expect(img().type).toBe('img');
    expect(img().props.src).toBe('https://other.example/cover?token=k');
    expect(img().props.crossOrigin).toBe('anonymous');
    expect(img().props).toMatchObject({ loading: 'lazy', decoding: 'async', alt: '' });
  });

  it('leaves a same-origin, blob or data cover without the attribute', async () => {
    for (const uri of [
      'https://books.example/api/v1/libraries/1/cover?token=k',
      'blob:https://books.example/2b8f',
      'data:image/png;base64,iVBORw0KGgo=',
    ]) {
      await render(<CoverImage source={uri} />);
      expect(img().props.crossOrigin).toBeUndefined();
    }
  });

  it('never sends the source headers (the URL carries the token)', async () => {
    await render(
      <CoverImage
        source={{ uri: 'https://other.example/c?token=k', headers: { Authorization: 'x' } }}
      />,
    );
    expect(JSON.stringify(img().props)).not.toContain('Authorization');
  });

  it('fills its box with the fit asked, fading in once loaded', async () => {
    await render(
      <CoverImage
        source="https://other.example/c"
        contentFit="cover"
        transition={150}
        style={{ width: '100%', height: '100%' }}
      />,
    );
    expect(img().props.style).toMatchObject({
      position: 'absolute',
      objectFit: 'cover',
      opacity: 0,
      transition: 'opacity 150ms ease-out',
    });
    await fire('onLoad');
    expect(img().props.style).toMatchObject({ opacity: 1 });
  });

  it('shows at once with no transition', async () => {
    await render(<CoverImage source="https://other.example/c" />);
    expect(img().props.style).toMatchObject({ opacity: 1 });
  });

  it('reports a failed load', async () => {
    const onError = jest.fn();
    await render(<CoverImage source="https://other.example/missing" onError={onError} />);
    await fire('onError');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('draws nothing without a source', async () => {
    await render(<CoverImage source={null} />);
    expect(screen.toJSON()).toBeNull();
  });
});
