import { colors } from './tokens';

// Node built-ins for this one test (the app's tsconfig has no Node typings).
declare const __dirname: string;
const { execFileSync } = jest.requireActual<{
  execFileSync: (file: string, args: string[], options: object) => string;
}>('node:child_process');

// The colour tokens have ONE source, src/theme/tokens.json, and two generated
// outputs: the @theme block in src/global.css (Tailwind classes) and
// src/theme/tokens.ts (raw values for native props). Hand-editing either output, or
// editing the JSON without regenerating, is drift - this regenerates both in memory
// (`--check` writes nothing) and fails if the checked-in files differ.
describe('colour tokens', () => {
  it('global.css and tokens.ts match src/theme/tokens.json (run `npm run gen:tokens`)', () => {
    let output = '';
    try {
      execFileSync(process.execPath, ['scripts/gen-tokens.mjs', '--check'], {
        cwd: `${__dirname}/../..`,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (e) {
      output = String((e as { stderr?: string }).stderr || e);
    }
    expect(output).toBe('');
  });

  it('keeps the exported shape consumers rely on', () => {
    expect(colors.primary).toBe('#db2777');
    expect(colors.light.bg).toBe('#e5e7eb');
    expect(colors.dark.surface).toBe('#1a2331');
    expect(Object.keys(colors.light)).toEqual(Object.keys(colors.dark));
  });
});
