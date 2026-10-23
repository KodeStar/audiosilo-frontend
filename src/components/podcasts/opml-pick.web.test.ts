import { OPML_ACCEPT, pickOpml } from './opml-pick.web';

// The web picker: a hidden file input, clicked once, answered by its `change` or
// `cancel` event. A stand-in document, as the Journal's web export test does.
type Listener = () => void;
function fakeInput() {
  const listeners: Record<string, Listener[]> = {};
  return {
    type: '',
    accept: '',
    style: {} as Record<string, string>,
    files: null as { name: string; size: number }[] | null,
    click: jest.fn(),
    remove: jest.fn(),
    addEventListener: (name: string, fn: Listener) => {
      (listeners[name] ??= []).push(fn);
    },
    fire: (name: string) => listeners[name]?.forEach((fn) => fn()),
  };
}

let input: ReturnType<typeof fakeInput>;
const g = globalThis as unknown as Record<string, unknown>;
const saved = g.document;
beforeEach(() => {
  input = fakeInput();
  g.document = { createElement: () => input, body: { appendChild: jest.fn() } };
});
afterAll(() => {
  g.document = saved;
});

describe('pickOpml (web)', () => {
  it('offers OPML and XML, and answers with the File itself as the body', async () => {
    const picking = pickOpml();
    expect(input.type).toBe('file');
    expect(input.accept).toBe(OPML_ACCEPT);
    expect(input.accept).toContain('.opml');
    expect(input.style.display).toBe('none');
    expect(input.click).toHaveBeenCalledTimes(1);
    const file = { name: 'subs.opml', size: 120 };
    input.files = [file];
    input.fire('change');
    await expect(picking).resolves.toEqual({ name: 'subs.opml', size: 120, body: file });
    expect(input.remove).toHaveBeenCalled();
  });

  it('answers null when the listener cancels, once', async () => {
    const picking = pickOpml();
    input.fire('cancel');
    input.files = [{ name: 'late.opml', size: 1 }];
    input.fire('change');
    await expect(picking).resolves.toBeNull();
    expect(input.remove).toHaveBeenCalledTimes(1);
  });
});
