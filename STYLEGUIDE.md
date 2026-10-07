# Stacks: AudioSilo player design system (Direction B)

> **This file is authoritative for the player.** It moved here from `design/player-redesign/stacks/` in the
> workspace repo in Phase 0b of the player redesign; that copy is the historical proposal. Change the design
> here, in the same change as the code. Section 17 maps the tokens below onto the real files.

> The household library. The player as a well-kept shared bookcase: covers stand on shelves, a series is a
> row of spines with the missing books as dashed ghosts, a finished year is a stack, and everyone in the
> house has their own place in every book.

Stacks is the sibling of the admin console's **Shelf** direction. It shares Shelf's porcelain and deep ink,
Bricolage Grotesque + Figtree + JetBrains Mono, cover shadows and the "one pink thing per view" rule, so
`/admin` and `/web` read as one product. It is tuned for listening: surfaces washed by the current cover,
a real player at every size, and physical shelf metaphors that make a household's books findable.

Target stack: **Expo SDK 56 + React Native 0.85 + React 19 + Expo Router**, **react-native-reusables**
(shadcn/ui "new-york" on `@rn-primitives`), styled with **Uniwind** (Tailwind v4 tokens; confirmed by the Phase 0a
spike, which moved the app off NativeWind v4, so NativeWind is no longer a fallback). Companions: `@expo/ui` bottom sheet (vaul on web), FlashList v2, charts drawn with react-native-svg,
expo-router native tabs, Reanimated 4, expo-glass-effect, expo-font, a vendored SVG icon set.

The prototype (`design/player-redesign/stacks/index.html` in the workspace repo, route `#styleguide`) shows this
document in action. Build it with `python3 build.py` from its `src/`. Where the two disagree, this file wins.

---

## 1. Principles

1. **Covers lead, chrome recedes.** Every list of books shows covers first. Chrome is flat with 1px hairlines.
   Only covers, spines and floating layers (dock, sheets, menus, toasts) cast shadows.
2. **The shelf is the metaphor.** Rows of covers stand on a ledge. A series is a row of spines whose width is
   the listening length; the book you chose is taken off the shelf and turned face-out. Missing books are
   dashed ghost spines with their real titles. A finished year is a stack. If it can be shown as a physical
   object, it is.
3. **Your place is sacred.** Never restart a book from 0. After any jump over a minute, offer "Back to
   12:41:07" for 10 seconds. Always say where progress lives: "Synced 2 min ago" or "Saved on this device,
   will sync". Spoilers never appear past the listener's own position.
4. **One pink thing per view.** `--brand` marks progress, the current book (the ribbon), selection and focus.
   Primary buttons are deep ink. If two unrelated things on screen are pink, one of them is wrong.
5. **A household, not a user.** Profiles with faces, a kids mode, "Listening in the house" (opt-in), collections
   shared with someone, "Sam is on book 3". Copy talks about people and books, never accounts and records.

---

## 2. Information architecture

### Destinations

| Form factor | Navigation | Destinations |
|---|---|---|
| Phone (< 640) | Bottom tabs (native tabs on iOS/Android, custom on web) + mini player | Home · Library · Search · Downloads · Me |
| Tablet (640-1023, iPad portrait) | Top bar with icon destinations + omnisearch, docked player | Home · Library · Downloads · You (+ Settings icon) |
| Desktop (>= 1024) | Top bar (64) + segmented sub-nav (50), right Up next drawer, docked player bar (84) | Home · Library · Downloads · You (+ Settings icon) |

```
Desktop
┌ Top bar: [mark AudioSilo / Hearthside + 1 more] Home Library Downloads You [ Search ... ⌘K ] [Up next 4] [⚙] [Chris ▾] ┐
├ Sub bar: Title  [segmented control of sections]                                         [contextual actions]          ┤
│ page content (max 1480)                                                       │ Up next drawer (300-480, resizable) │
└ Docked player: [cover · chapter · book · sync]   [|◁ ↺15 ▶ ↻30 ▷|  chapter scrubber]   [undo] [1.25x] [☾] [+🔖] [⇪] [≡] [^] ┘
```

| Destination | Sub-nav sections | Routes |
|---|---|---|
| Home | none: greeting, Now card, This week, Continue listening, Next in your series, Listening in the house, Smart shelves, Recently added, Favourites, Recently finished | `#home` |
| Library | Books · Authors · Series · Narrators · Collections · Folders | `#library`, `#series`, `#author`, `#book` |
| Downloads | none (storage, rules, queue, ready offline) | `#downloads` |
| You | Stats · Year in listening · Journal | `/you?section=stats\|year\|journal` (the Me tab's root) |
| Settings (gear) | none: a page pushed on the current tab (Back returns there), with its own grouped section nav | `/settings?section=preferences\|accounts\|<pane>`, `/account?connection=` |
| Overlays | Full player and Finished rise over the current page | `#player`, `#finished` |
| Standalone | Onboarding / first run; kids mode replaces the whole app | `#connect` |

- Phone **Me** tab is a hub (`/you?section=`): a large title naming the section ("Your listening") and a
  scrolling segmented control (Stats · Year · Journal · Settings · Account). On tablet and desktop the same
  root is the top bar's **You**; its sub-nav offers only Stats · Year in listening · Journal (Settings is the
  gear, Account the profile menu; an old link to either still renders). The Journal is a section of the hub
  (`/journal?tab=` still opens for older links).
- **Settings** (`SettingsContent`, the `/settings` page and the phone hub's Settings segment) lays out by
  its measured width: from 720 a grouped section nav (Listening · App · Servers) beside one pane's card,
  narrower every pane stacked under its group's name.
- Detail pages (`#series`, `#author`, `#book`) replace the segmented control with Back + breadcrumbs.
- Hash routes are bare tokens; sub-state (tab, filters, selected series entry) lives in app state
  (Expo Router search params in the real build).
- **Each setting lives in exactly one place**: Settings panes are Listening (Playback, Sleep, Up next and
  downloads), App (Appearance, Language, Household and sharing: a quiet "arrives with profiles" notice until
  profiles ship) and Servers (Accounts and devices: the signed-in servers, each opening its Account, and Add
  a server; Support, hidden in Apple builds). Accessibility gets a pane only once the app has a setting of
  its own for it (motion and text size follow the system today). Download rules also show in Downloads and
  in the series page as *shortcuts to the same value*, never a second copy.

---

## 3. Tokens (`global.css`)

```css
@import "tailwindcss";

:root {
  --radius: 14px;

  --background: #f5f7fa;          /* cool porcelain, never cream */
  --foreground: #121c36;          /* ink-navy */
  --card: #ffffff;               --card-foreground: #121c36;
  --popover: #ffffff;            --popover-foreground: #121c36;
  --primary: #15203d;            --primary-foreground: #f5f7fa;   /* play button, primary buttons, toasts */
  --secondary: #eaedf3;          --secondary-foreground: #18244a;
  --muted: #eef1f5;              --muted-foreground: #5b6680;
  --subtle-foreground: #8590a6;
  --accent: #e8ecf3;             --accent-foreground: #121c36;    /* hover on ghost items */
  --destructive: #c42b3c;        --destructive-soft: #fde8ea;
  --border: #e0e5ed;             --border-strong: #cdd4df;
  --input: #d4dae4;              --ring: #db2777;

  --brand: #db2777;              /* the one pink thing */
  --brand-foreground: #ffffff;
  --brand-soft: #fce7f1;
  --brand-ink: #a3195a;          /* pink text on light (AA) */

  --success: #0d7f5a;  --success-soft: #e1f5ec;
  --warning: #a86206;  --warning-soft: #fdf1dc;
  --info: #2c56c9;     --info-soft: #e6edfd;
  --community: #6a3fd4; --community-soft: #efe9fd;   /* CC BY-SA marks, note pins */

  --chart-1: #db2777; --chart-2: #3b5bdb; --chart-3: #0d9488; --chart-4: #d97706; --chart-5: #7c3aed;
  --seq-0: #e9edf3; --seq-1: #fbd5e6; --seq-2: #f5a3c7; --seq-3: #e8649f; --seq-4: #cc2b78; --seq-5: #8f1550;

  --shelf-edge: #d9dfe8;         /* ledges, planks, bookends */
  --shelf-shadow: rgb(18 28 54 / .16);
  --topbar: rgb(245 247 250 / .84);
  --glass: rgb(255 255 255 / .72);  --glass-border: rgb(18 28 54 / .08);
  --overlay: rgb(14 20 38 / .38);
  --wash: .30;                   /* strength of the cover-colour wash */

  --shadow-cover: 0 1px 1px rgb(18 28 54 / .10), 0 4px 8px -2px rgb(18 28 54 / .14), 0 16px 28px -10px rgb(18 28 54 / .30);
  --shadow-cover-hover: 0 2px 2px rgb(18 28 54 / .10), 0 10px 18px -6px rgb(18 28 54 / .20), 0 28px 44px -14px rgb(18 28 54 / .38);
  --shadow-overlay: 0 24px 64px -16px rgb(14 22 48 / .30), 0 2px 6px rgb(14 22 48 / .08);
  --shadow-dock: 0 -1px 0 var(--border), 0 -12px 32px -18px rgb(14 22 48 / .22);

  --font-display: "Bricolage Grotesque", "Figtree", ui-sans-serif, system-ui, sans-serif;
  --font-sans: "Figtree", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;

  --ease-out: cubic-bezier(.2, .8, .2, 1);
  --ease-spring: cubic-bezier(.34, 1.36, .64, 1);
  --dur-1: 120ms; --dur-2: 200ms; --dur-3: 320ms; --dur-4: 520ms;
}

/* Dark: deep ink where covers glow. Apply for .dark / data-theme=dark, and for system dark unless light is forced. */
.dark {
  --background: #0a0f1e; --foreground: #e7ebf4;
  --card: #10172b; --card-foreground: #e7ebf4; --popover: #131b31; --popover-foreground: #e7ebf4;
  --primary: #eef1f8; --primary-foreground: #0a0f1e;
  --secondary: #1a2340; --secondary-foreground: #dfe5f2;
  --muted: #151d34; --muted-foreground: #8f9ab3; --subtle-foreground: #66718b;
  --accent: #1a2340; --accent-foreground: #e7ebf4;
  --brand: #ec4f95; --brand-soft: #3a1530; --brand-ink: #f78bbb;
  --destructive: #f0606e; --destructive-soft: #3a1720;
  --success: #3cc994; --success-soft: #0f2e26; --warning: #f0b04d; --warning-soft: #33260f; --info: #7d9bf2; --info-soft: #17234a;
  --community: #b59cff; --community-soft: #251b45;
  --border: #1d2640; --border-strong: #2a3555; --input: #283252; --ring: #ec4f95;
  --chart-1: #e4458b; --chart-2: #6680ec; --chart-3: #17a093; --chart-4: #cc7f16; --chart-5: #8f72f2;
  --seq-0: #161e36; --seq-1: #3a1a37; --seq-2: #6b1f4f; --seq-3: #a12a6a; --seq-4: #d9418a; --seq-5: #f58bbb;
  --shelf-edge: #1f2944; --shelf-shadow: rgb(0 0 0 / .5);
  --topbar: rgb(10 15 30 / .80);
  --glass: rgb(22 30 54 / .70); --glass-border: rgb(255 255 255 / .07);
  --overlay: rgb(3 6 14 / .62);
  --wash: .42;
  /* --glow is set per cover to its vibrant colour: covers glow on deep ink */
  --shadow-cover: 0 1px 1px rgb(0 0 0 / .4), 0 8px 16px -4px rgb(0 0 0 / .55), 0 18px 40px -12px var(--glow, rgb(236 79 149 / .18));
  --shadow-cover-hover: 0 2px 2px rgb(0 0 0 / .4), 0 14px 24px -6px rgb(0 0 0 / .6), 0 26px 60px -12px var(--glow, rgb(236 79 149 / .32));
  --shadow-overlay: 0 30px 80px -10px rgb(0 0 0 / .7), 0 0 0 1px rgb(255 255 255 / .04);
  --shadow-dock: 0 -1px 0 var(--border), 0 -16px 40px -20px rgb(0 0 0 / .7);
}

@theme inline {
  --color-background: var(--background);   --color-foreground: var(--foreground);
  --color-card: var(--card);               --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);         --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);         --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);     --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);             --color-muted-foreground: var(--muted-foreground);
  --color-subtle-foreground: var(--subtle-foreground);
  --color-accent: var(--accent);           --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive); --color-destructive-soft: var(--destructive-soft);
  --color-border: var(--border);           --color-border-strong: var(--border-strong);
  --color-input: var(--input);             --color-ring: var(--ring);
  --color-brand: var(--brand);             --color-brand-soft: var(--brand-soft);   --color-brand-ink: var(--brand-ink);
  --color-success: var(--success);         --color-success-soft: var(--success-soft);
  --color-warning: var(--warning);         --color-warning-soft: var(--warning-soft);
  --color-info: var(--info);               --color-info-soft: var(--info-soft);
  --color-community: var(--community);     --color-community-soft: var(--community-soft);
  --color-chart-1: var(--chart-1); --color-chart-2: var(--chart-2); --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4); --color-chart-5: var(--chart-5);
  --color-seq-0: var(--seq-0); --color-seq-1: var(--seq-1); --color-seq-2: var(--seq-2);
  --color-seq-3: var(--seq-3); --color-seq-4: var(--seq-4); --color-seq-5: var(--seq-5);
  --color-shelf-edge: var(--shelf-edge);
  --font-display: var(--font-display); --font-sans: var(--font-sans); --font-mono: var(--font-mono);
  --radius-sm: calc(var(--radius) - 6px);  /* 8: small controls, chips inside cards */
  --radius-md: calc(var(--radius) - 4px);  /* 10: buttons, inputs */
  --radius-lg: var(--radius);              /* 14: menus, toasts */
  --radius-xl: calc(var(--radius) + 2px);  /* 16: cards */
  --radius-2xl: calc(var(--radius) + 6px); /* 20: dialogs, palette */
  --radius-3xl: calc(var(--radius) + 10px);/* 24: Now card, sheets */
}
```

Web dark-mode rule: define dark under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...} }`
**and** `:root[data-theme="dark"] {...}`. Native: Uniwind theme switching with the same variables.

### Colour usage

| Token | Light | Dark | Use for |
|---|---|---|---|
| `--background` | `#f5f7fa` | `#0a0f1e` | Canvas. Never cream or beige. |
| `--foreground` | `#121c36` | `#e7ebf4` | Body text, ink waveform bars, timeline past chapters |
| `--primary` | `#15203d` | `#eef1f8` | Play button, primary buttons, toasts, tooltips, Undo chip |
| `--brand` | `#db2777` | `#ec4f95` | Progress fills, playhead, current chapter, the ribbon on the book you're on, switches on, focus ring |
| `--brand-ink` | `#a3195a` | `#f78bbb` | Pink *text* (links, "Just met", Listening badge) |
| `--brand-soft` | `#fce7f1` | `#3a1530` | Active pill (sleep timer running), Up next drop target |
| `--community` | `#6a3fd4` | `#b59cff` | Community-notes globe, note pins on the timeline |
| `--success` | `#0d7f5a` | `#3cc994` | Finished, downloaded, synced (always with an icon and a word) |
| `--warning` | `#a86206` | `#f0b04d` | Offline banner, "Spoilers shown", star ratings |
| `--destructive` | `#c42b3c` | `#f0606e` | Sign out, remove server, failed download |
| `--info` | `#2c56c9` | `#7d9bf2` | "On Maya's Shelf" (a friend's server), "Also on ..." |
| `--seq-0..5` | pink ramp | pink ramp | Listening calendar heatmap only |
| `--chart-1..5` | fixed order | fixed order | Storage per server, any categorical chart. A sixth series folds into "Other". Where the view already has its pink thing (the Downloads page), start at `chart-2` and use `chart-1` last. |

### Cover-derived colour

The server computes a **dominant** and a **vibrant** colour per cover (planned endpoint) and sends them with the
book, so tinting works before the image loads, on every platform. In the prototype both come from the same
deterministic palette that draws the procedural cover.

- `--tint` (dominant) and `--accent2` (vibrant) are set per book with the `style` prop on: the Now card, the book
  hero, the series hero, the full player, the Finished screen, the Android media notification.
- The wash is two radial gradients at `--wash` strength (30% light, 42% dark), always over the page background
  and under a scrim. Text never sits on raw cover colour; controls stay ink and pink.
- In dark mode `--glow` (the vibrant colour at 45-55%) is the far shadow of covers, so covers glow on ink.
- Native: the same two colours drive an `expo-glass-effect` tint on iOS 26 and a Skia mesh gradient on native
  only (optional). Web uses CSS gradients and `filter: blur(70px)` of the cover for the hero backdrop.

---

## 4. Typography

| Role | Family | Size / line (phone) | Weight | Tracking | Example |
|---|---|---|---|---|---|
| Display XL | Bricolage Grotesque | 52/52 (30) | 750 | -0.035em | The Way of Kings (book, series hero) |
| Display | Bricolage Grotesque | 34/36 (28) | 700 | -0.03em | Good evening, Chris. |
| Player chapter | Bricolage Grotesque | 30/32 (23) | 750 | -0.03em | 23. Bridge Four |
| Now-card title | Bricolage Grotesque | 36/36 (24) | 750 | -0.035em | The Way of Kings |
| Heading | Bricolage Grotesque | 19/22 | 680 | -0.02em | Next in your series |
| Title | Bricolage Grotesque | 15/18 | 650 | -0.01em | Project Hail Mary |
| Stat | Bricolage Grotesque | 32/32 (25) | 750 | -0.035em | 11h 6m |
| Story number | Bricolage Grotesque | 92/78 | 800 | -0.06em | 412 |
| Body | Figtree | 14/21 | 400 | 0 | Kaladin decides to stop waiting to die. |
| Recap body | Figtree | 14.5/24 | 400 | 0 | (Story so far paragraphs) |
| Label | Figtree | 13/18 | 650 | 0 | Skip forward |
| Caption | Figtree | 12.5/18 | 400 muted | 0 | 22h 27m left at 1.25x |
| Eyebrow | Figtree | 12/16 | 650 caps | +0.06em | THE STORMLIGHT ARCHIVE · BOOK 1 |
| Mono | JetBrains Mono | 12.5/20 | 500 | -0.01em | Fiction/Brandon Sanderson/... |

- All times, counts and speeds use `font-variant-numeric: tabular-nums` (`tabular-nums`).
- Quotes (bookmarks labelled "Quote") are set in Fraunces italic; this is the only literary flourish in UI chrome.
  In the app they render in the body font in italic inside the locale's quote marks, because Fraunces is not
  bundled.
- Cover fonts (Cinzel, Anton, Fraunces, Instrument Serif, Fredoka, Unbounded) appear only inside covers, spines,
  quotes and kids mode. Bundle them with expo-font; subset to Latin.
- Every label survives +30% (de/fr/pt/es/it): buttons grow, segmented controls scroll horizontally, tile titles
  clamp to two lines, the Now-card eyebrow wraps.

---

## 5. Space, radius, elevation, density

- **Spacing** (4 grid): 4 icon gap · 8 inline · 12 rows · 16 card gap and phone gutter · 20 card padding · 24 page
  gutter · 30-40 between shelves.
- **Radius**: covers 5 (7 hero, 9 player, 22 kids) · 8 small · 10 buttons/inputs · 14 menus/toasts · 16 cards ·
  20 dialogs/palette · 24 Now card and sheets (34 on iOS) · full for avatars, chips, transport buttons.
- **Elevation**: three levels only. (1) flat + hairline for all chrome and cards; (2) `--shadow-cover` for covers
  and spines (lift to `--shadow-cover-hover` + `translateY(-3px)` on hover); (3) `--shadow-overlay` for dock,
  drawer-as-overlay, sheets, menus, toasts, palette.
- **Density**: comfortable. Cover grid `repeat(auto-fill, minmax(158px, 1fr))` (2 columns on phone), shelf rows
  164 px tiles (132 phone), list rows 56-72, touch targets 44 pt (64 in kids mode, 120 for the kids play button).

---

## 6. Motion

| Token | Value | Used for |
|---|---|---|
| `--dur-1` | 120 ms | Hover, press, colour |
| `--dur-2` | 200 ms | Menus, popovers, cover lift |
| `--dur-3` | 320 ms | Sheets, drawer, toasts, undo chip, spine lift |
| `--dur-4` | 520 ms | Full player rise, cover "breathe" (scales to 94% on pause), FLIP reorder of the series shelf |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | Default entrance |
| `--ease-spring` | `cubic-bezier(.34,1.36,.64,1)` | Play button, switch thumb, character reveal, spine drop |
| Face-out | 560 ms, rotateY(-75deg) to 0 | A spine taken off the shelf turns to show its cover |
| Reveal | 900 ms spring + blur(6px) to 0 | A character appearing in Who's who as playback crosses into their chapter |
| Spine drop | 700-900 ms spring | "Your library is ready", the finished book landing on your year shelf |
| Story bars | 6 s linear | Year in listening auto-advance |

Animate transform, opacity and colour only. Only live indicators loop (the equaliser on the current chapter,
the "listening now" pulse). `prefers-reduced-motion` (and Settings > Accessibility > Reduce motion) collapses
every animation to an instant change, stops the Year story auto-advancing and disables FLIP. Reanimated 4 CSS
transitions implement all of these on native; the shared-element cover zoom (grid to book hero) is iOS only.

---

## 7. Iconography

Lucide geometry on a 24 grid, 2 px stroke, round caps, vendored as SVG (no icon library dependency). Play and
pause are **filled** glyphs; skip back/forward are a circular arrow with the seconds set inside (15, 30, any of
5-120). Sizes: 12-14 meta, 15-16 buttons, 18-22 navigation, 24-36 transport. Icons label, they don't decorate:
always next to text or with an accessibility label. Fixed meanings: `moon` sleep · `bookmark` bookmark · `note`
pinned note · `queue` Up next · `server` a server · `globe` community notes · `eyeOff` hidden for spoilers ·
`transcode` converted for this browser · `hdd` saved on this device · `cloud` synced · `wave` smart speed /
voice boost · `undo` back to where you were. No emoji anywhere.

---

## 8. Components

Names are react-native-reusables components unless marked *custom*.

### Button
Variants `default` (ink), `outline`, `secondary`, `ghost`, `destructive`, `destructive-outline`, `link`, and a
rare `brand` (pink) for at most one moment in a flow. Sizes 30 / 38 / 46 / 54. Labels say what happens with the
specifics: "Resume chapter 23", "Download for offline", "Sleep at end of chapter", "Queue it after this book".
Android adds a ripple from the press point; iOS adds a light haptic on primary actions.

### Input, Textarea, Select, Switch, Checkbox, RadioGroup (radio cards), Slider
Inputs 40 (48 for invite code and server address), radius 10, focus = `--ring` border + 3 px 20% ring. Switch on
= `--brand` (Android: Material 3 thumb that grows when on). Slider (speed) is hand-built: ink fill, white thumb.

### Segmented control (Tabs, "segmented" variant) and underline Tabs
Sub-nav, Library browse modes, reading-order switcher, Appearance: muted track + raised card for the active item,
counts in subtle tabular text. Book tabs and the companion use underline tabs (ink underline).

### Chip (Toggle) and Badge
Filter chips 32 tall with counts; pressed = ink fill. Badges 22: secondary, outline, ink, success, warning,
destructive, info, brand, community. A dashed `flag-chip` marks anything that needs new server work
("Live needs server work").

### Cover *custom, signature*
Square, radius 5, `--shadow-cover`, a spine crease + gloss overlay and a fine noise texture. Real art when the
server has it; otherwise a **procedural cover** from `title|author`: 16 layouts chosen by genre (`epic` sigil and
storm spiral with a double gold frame, `sf` planets and orbits, `lit` colour fields with italic serif, `halls`
receding arches, `crime` tape band, `nf` bold grotesk, `memoir` duotone sun, `kids` hills and a friendly creature,
`comic` halftone starburst, `classic` tri-band, `deco` sunburst fan, `swiss` giant series numeral, `topo` contour
map, `mosaic` Bauhaus tiles, `myth` black-figure disc and meander, `map` parchment trail). Type is sized in
container units with a fit function so the longest word always fits; one component works from a 36 px queue
thumb to a 400 px player. In the real build render the art as a React Native SVG component (react-native-svg),
not an HTML string.

### Ghost cover and ghost spine *custom, signature*
A book the listener doesn't have: hatched muted fill, 1.5 px dashed outline, "Book 3", the real title from
community series data, "Not in your library". A ghost on a friend's server is tinted `--info` with a server icon
and the tag "On Maya's Shelf". Never fake art for a book that isn't there.

### Spine *custom, signature*
Vertical book spine in the cover's palette: rounded top, side shading, two bands in the secondary colour, series
number at the top, rotated title in the cover's typeface framed by the two bands, author surname at the foot
(only when the spine is wide enough). **Titles always fit**: keep the base size if it fits, else tighten tracking,
else shrink (down to 82%), else wrap to two lines on spines 40+ px wide, else shrink to a 5 px floor; ellipsize
only as a last resort on very thin spines (and then the full title is the tooltip and accessibility label). **Width follows listening length** (`10 + sqrt(minutes) x 1.1`, clamped 24-72, scaled); height
varies a little per title. States: finished (green check at the foot), reading (lifted 14 px, pink ribbon tucked behind the book and
peeking out above its top edge), ghost (above). **Ribbons never sit over cover or spine typography**: they are
layered behind the book and only the part above the top edge shows.

### Shelf row with ledge *custom*
Horizontal snap-scrolling row of cover tiles (FlashList horizontal). A 8 px ledge with a soft shadow sits
**directly under the covers** (drawn as the row's background at `tile + 6px`, attached to the scroll content);
titles and meta hang below the ledge.

### Series shelf *custom, signature*
The series page hero. Spines stand on a plank in the chosen reading order; the selected entry is **taken off the
shelf and turned face-out** as a cover (or ghost cover) with the ribbon if it's the book you're on. Switching the
reading order (Publication / Chronological / Recommended, from community data) animates the spines to their new
places (FLIP). Below the plank: a caption with book number, year, length, status badge and the one right action
(Resume chapter 23 · Queue it · Listen on Maya's Shelf · Want to listen) and a legend (on your servers, on a
friend's server, not in your library, listening now). A segmented progress track shows every entry (green
finished, pink partial, hatched missing) with "38% into book 1 · 262h of listening ahead".

### Now card *custom*
Home's hero: the current book on a cover-tinted card. Eyebrow (series and number), title, `Chapter 23 of 81` +
chapter title (+ equaliser while playing), a **whole-book scale** (one tick per chapter, sized by duration; past
in ink, current in pink; bookmark pins above), three stats (percent, time left at your speed, estimated finish
date at your pace), Resume / Who's who (count) / Story so far, and a household hint ("Sam is on book 3").
Phone: cover and title side by side, buttons full width.

### Docked player bar (desktop/tablet) *custom*
84 tall translucent bar with a 3 px whole-book progress line along its top edge. Left: cover, chapter title,
book · author, sync state. Centre: previous chapter, skip back, play, skip forward, next chapter; chapter
scrubber with bookmark ticks and time left in the book at your speed. Right: Undo chip (when present), speed,
sleep (shows its countdown and turns `--brand-soft` while running), bookmark, output, Up next, expand. Click the
book to open the full player.

### Mini player (phone) *custom*
56 tall. iOS: a Liquid Glass pill in the native tab bar's **bottom accessory slot**, round cover. Android/web: a
card above the navigation bar. Chapter title, book · time left (sleep countdown if running), skip back, play,
and a 2.5 px chapter progress line.

### Full player *custom, signature*
Rises over the current page (route `#player`). Cover washed into the background; the cover "breathes" (94%
when paused). Chapter title (tap for the chapter list), book · author, a status line ("Synced just now · 38% of
the book · 22h 27m left at 1.25x") that becomes the **Undo chip** after a jump, the **chapter-relative waveform
seek bar** with live scrub preview ("41:12 · 17:26:50 in the book"), "21m left in the chapter · ends 22:01", the
**whole-book timeline** (compact), transport (54/76), and actions: speed, sleep, bookmark, output, Up next
(phone/tablet), smart speed / voice boost ("Saved 2h 11m" native, "Voice boost" web). Desktop: a 420 px
companion column (Who's who · Story so far · Chapters · Bookmarks · Notes). Tablet: the companion sits below
the controls. Phone: chips open the companion as a 78% bottom sheet.

### Seek bar (waveform) and chapter timeline *custom on primitives*
Seek bar: 96 bars (56 phone) of a deterministic speech-like envelope; played bars ink, hovered bars 55% ink,
4 px pink playhead with a halo; bookmark glyphs above bars. Keyboard: arrows skip back/forward; `aria-valuetext`
reads "41:12 of 1:17:48". Timeline: one segment per chapter placed by time (2 px gaps cut from each segment's end), past ink 34%, current
pink 26% with the played part solid pink, playhead; bookmark pins (ink) and note pins (`--community`) on stems
above; hover tooltip names the chapter; click seeks (with Undo).

### Undo jump chip *custom*
Ink pill: undo icon, "Back to 17:26:50", and a ring that empties over 10 s. Appears after any jump over 60 s
(scrub, chapter tap, timeline click, bookmark jump, lock-screen seek). Tap restores and toasts "Back where you
were".

### Up next *custom*
Desktop: right drawer, 360 px, resizable 300-480 by its left edge, collapsible (Q). Tablet/phone: bottom sheet.
Now playing card, then the queue with **drag-to-reorder by the grip** (pointer events; arrow keys move a focused
row), play-now and remove on hover, Clear (with Undo). A dashed drop zone accepts **any cover dragged from the
page** (desktop). Then "Continue the series and more" suggestions (next in series, unfinished books) and a ghost
for a missing next book ("Oathbringer is on Maya's Shelf"). Auto-play next switch at the foot.

### Companion: Who's who and Story so far *custom, signature*
Gated on the device by the listener's own position (the server can't know it, and downloads play offline).
Who's who: newest first, character token (initial on a hue), name, role, aliases, a spoiler-safe blurb, "First
appears in 5. City of Bells". A character whose chapter you just crossed animates in with a pink outline and
"Just met", plus a toast; that is the card's only pink (the role chip and "From chapter N" stay muted). Hidden entries are counted, never named: "7 characters you haven't met yet are hidden"
with **Show anyway** (then a warning badge and "Hide them again"). Story so far: "Up to chapter 22", written to
stop exactly there; the next paragraph fades in when you finish a chapter. The whole-book summary (`in_short`
includes the ending) is blurred behind "Show the whole-book summary". Every block ends with the attribution
"Community notes from AudioSilo Meta contributors · CC BY-SA 4.0".

### Previously on *custom*
Shown on Home when resuming after a long gap (12+ days): dark cover-tinted card, "You left Kaladin in Bridge Four,
deciding to stop waiting to die.", one recap paragraph, "Resume, with 30 seconds of overlap", "Read the full
recap", and the spoiler-safe attribution.

### Sheets (speed, sleep, bookmark, output, chapters, Up next, companion)
Desktop: an anchored popover above the dock (or centred over the player column). Tablet: centred floating sheet.
Phone: bottom sheet with grabber (`@expo/ui` detents on native, vaul on web).
- **Speed**: big readout, slider 0.5-2.0 in 0.05 steps with minus/plus, presets with the resulting time left
  ("1.5x · 18h 42m"), "remembered for this book", smart speed and voice boost switches (smart speed disabled on
  web with "Not available in the browser").
- **Sleep**: 5/10/15/30/45/60 min, End of chapter (with its countdown), "Or stop after" 1-4 chapters with their
  end times ("ends 22:49"), Auto sleep (window from Settings), Shake to extend (native only), and the note that a
  "Fell asleep" bookmark is saved. The last 30 s show the **grace card**: "Fading out in 24 s · Keep listening".
- **Bookmark**: position, note, and a label: Quote, Favourite, Re-listen, Funny or Question (plus the automatic
  Fell asleep, which the sleep timer sets and the picker never offers). The clip affordance is not built: no phase
  schedules clips, so the player shows no placeholder for it.
- **Output**: this device, AirPods, AirPlay speakers, Chromecast; "Continue on iPad" hand-off (flagged: needs a
  realtime channel).

### Command palette (web ⌘K) *custom*
Opened from the omnisearch, ⌘K / Ctrl+K or `/`. Recent searches as chips, then groups: Actions (Resume chapter 23,
Sleep in 30 minutes, Sleep at end of chapter, Add a bookmark here, Open the full player, Go to settings, Open Year
in listening, Switch profile, appearance), Books (cover, server, progress), Series, Authors, Narrators,
**Characters (only people you've met; "2 more match after your place in the book")**, Go to. 48 px items, match in
`--brand-ink` bold, ↵ on the active row, footer with key hints and "13 results · Hearthside + Maya's Shelf".

### Toast, Dialog, Banner, Notice
Toasts are ink, one line + one description + at most one action (Undo, Add note, Show); bottom-right (above the
tab bar on phone). Dialogs radius 20 with a 40 px tinted icon badge; on phone they become bottom sheets. Banners
sit under the top bar for app-wide states. Notices (icon tile + bold headline + one sentence + at most two
actions) explain local situations.

### Stat tile, listening calendar, listening clock *custom on react-native-svg*
Stat tile: label with icon, Bricolage 32 value (25 on a narrow page) with small units, one line of context or a
delta, read as one element ("This week, 5h 9m, 3h 41m less than last week"). Listening calendar: 53 x 7 rounded
squares on `--seq-0..5` (graded against the listener's own heavy days, the 95th percentile, so one marathon
doesn't wash the rest out), month and weekday labels, today outlined, a tooltip ("1h 36m · Sat 3 Oct") on hover
on the web and on a tap everywhere, legend Less/More, "N days with listening in the last 12 months"; below an
11 pt cell it scrolls sideways and starts at today. Listening clock: 24 radial petals from 00 at the top, peaks
(75% of the busiest hour or more) in `--brand`, the rest ink, the busiest hour in the centre, or the hour under
the pointer or a tap. Weekly bars: the last 12 seven-day windows as 18 px bars with 4 px rounded tops on a dashed
hour grid, this week in pink, the week under the pointer or a tap in a tooltip. On these pages the clock's peaks
and this week's bar are the pink; the goal ring, rank bars and links stay ink. Rank lists (top authors,
narrators, series) use portraits (a series: its monogram cover) + an ink bar, each row opening its page.

In this codebase (`src/components/you/stats/`): the charts are react-native-svg drawings and Views, not
gifted-charts (never installed). Each chart is one `image` element with a text summary, and is read without
hover: `ChartPointer` lays a layer over the drawing that reports the point under a web pointer or a tap, and
`ChartTip` is the ink tooltip. All the rules (weeks, streaks, the grid, the petals, hit tests, the goal steps,
the layout columns) are the pure `stats-model.ts`. The page lays out by its measured width. Finished this year
is a shelf of `Spine`s on the series bookcase's `Plank` (the stats carry no length or cover colour, so the
spines are the standard width in their title's cloth colour), and the Year banner is a washed ink card in the
blue and violet chart colours, not pink.

### Avatar, portrait, character token *custom*
Household avatars: gradient monograms (two hues per person), Bricolage initials; a pink ring marks who is
listening on this device. Author portraits: pale gradient discs with Fraunces initials (no photos); narrator
portraits are rounded squares with a faint waveform. Character tokens: initial on a hue per character; hidden
tokens are dashed with an eye-off icon.

### Profile picker and kids mode *custom, signature*
"Who's listening?" over a blurred app: 96 px avatars with a one-line status ("Kids mode · bedtime 19:30", "Large
text"), Add (needs an invite). Choosing Leo switches the whole app to **kids mode**: warm gradient, Fredoka, "Hi
Leo", a bedtime card, one huge book with a 120 px play button and 84 px skip buttons, then the Kids library as big
rounded covers. No search, settings or downloads. Leaving needs a grown-up to **press and hold for 2 seconds**.
Decision for the owner: profiles on a device marked "shared" switch without a password.

### Year in listening *custom*
9:16 story cards with progress bars, tap right/left to move, 6 s auto-advance: 412 hours · 41 books as a growing
tower of spines ("1.6 metres tall") · book of the year · voice of the year · your listening clock · longest streak
· 214 characters met (and no spoilers) · the house together · a share card. Shareable as one read-only link.

### Empty, skeleton, first run
Empty states use ghost spines or ghost covers, one headline, one sentence, one action. Skeletons are exact
cover-shaped placeholders (no layout shift), shimmer 1.4 s (off with reduced motion). First run ends with **"Your
library is ready."**: spines drop onto a plank one by one, with the counts and where your place came from.

---

## 9. Patterns

- **Continue the series**: Home's "Next in your series" uses community series data, not folder order; each card
  says why ("After book 3, which you're 55% into"). Owned next books can be queued, kept ahead offline (Keep 0-3
  ahead) and auto-played; missing ones are ghosts with "Want to listen"; ones on a friend's server open there.
- **Cross-server**: Home, Search and Library aggregate across servers; a small "Maya" flag marks a friend's book;
  search de-duplicates with "Also on Maya's Shelf"; content and accounts stay per server.
- **Reliability shown, not promised**: sync state in the dock and full player; offline banner that never spins;
  downloaded books marked on covers; failed downloads keep their percent ("Your 41% is kept"); playback errors
  offer Retry and say the place is saved.
- **Sleep**: timer, end of chapter(s), auto sleep window, fade, grace card, shake to extend, a "Fell asleep"
  bookmark, and the next morning in the Journal: "You drifted off around 23:17. Jump back 4 minutes?".
- **Spoiler safety**: characters, recaps, palette results and search results are filtered by the listener's own
  chapter; hidden counts are shown kindly; the ending is always behind a deliberate tap.

---

## 10. Platforms

| | iOS | Android | Web |
|---|---|---|---|
| Tabs | expo-router native tabs, Liquid Glass, Search as the separate circle, minimise on scroll | Material 3 navigation bar, pill indicator | Custom bar on phone widths; top bar + sub-nav at >= 640 |
| Mini player | Bottom accessory slot of the tab bar, glass pill | Card above the bar | Card above the bar; dock on tablet/desktop |
| Headers | Large titles on tab roots; inline back with the parent name | Top app bar, back arrow | Top bar; breadcrumbs on detail pages |
| Sheets | SwiftUI detents, 34 pt corners, grabber | Material 3 bottom sheet | vaul; popovers on desktop |
| Feedback | Haptics on play, skip, bookmark | Ripple from the press point | Hover states everywhere |
| Output | AirPlay route picker | Cast | Browser output; Media Session |
| OS surfaces | Lock screen, Dynamic Island, Live Activity (chapter, time left, sleep countdown), widgets, CarPlay, App Intents | Media notification with chapter prev/next and chapter scrubber, Android Auto, App Actions | PWA install prompt, Media Session (artwork, chapter, skips) |
| Not available | | | Smart speed (voice boost works via Web Audio), shake, widgets, CarPlay. Say "Not available in the browser". |

Web is the desktop and casual surface (iOS Safari PWAs are weak at background audio), so the Downloads page
explains browser storage honestly: secure context only, the browser may evict, Safari stops in the background.

---

## 11. Keyboard (web)

Space or K play/pause · J or ← back · L or → forward · Shift+←/→ previous/next chapter · [ and ] speed -/+ 0.05 ·
B bookmark · P full player · Q Up next · Z sleep · ⌘K or / palette · ? shortcuts overlay · Esc closes the top
layer. Shortcuts never fire while typing.

---

## 12. Voice and copy

- Plain, warm, specific. Buttons say what happens: "Resume chapter 23", "Download for offline", "Sleep at end of
  chapter", "Queue it after this book".
- Times read naturally: "22h 27m left at 1.25x", "ends 22:49", "finish around 20 Oct at your pace".
- Spoiler copy is kind: "7 characters you haven't met yet are hidden".
- Errors say what went wrong, whether anything was lost, and the fix: "Hearthside stopped responding. Your 41%
  is kept."
- Sentence case, no emoji, no exclamation marks, never the em dash (use a hyphen or restructure). Tabular numbers.
  Relative time for recency ("2 min ago"), absolute for records ("Today 21:12").

---

## 13. Do and don't

| Do | Don't |
|---|---|
| "Resume chapter 23" in an ink button | "Play" in a pink button |
| Missing books as ghost spines with real titles | Hiding gaps, or a grey row that says "missing" |
| Count hidden characters kindly | Show a name from chapter 46 to someone on chapter 23 |
| Shadows on covers and spines only | Floating cards with heavy shadows |
| One pink thing: the progress, the ribbon | Pink headings, pink buttons and pink charts together |
| Tint with the server's cover colours under a scrim | Text directly on raw cover colour |
| "Back to 17:26:50" after every big jump | Silent jumps you can't undo |
| "Not available in the browser" on a disabled switch | Hiding native-only features without saying why |
| Status = icon + word | Colour alone |

---

## 14. Accessibility

- Visible focus: 2 px `--ring` outline, 2 px offset, on everything interactive.
- Player controls have labels ("Back 15 seconds", "Next chapter"); the seek bar is a slider with value text.
- Palette is a combobox + listbox; menus, tabs, sheets and dialogs are keyboard operable and `aria-modal`.
- Contrast: body and muted text meet AA on both themes; pink text uses `--brand-ink`.
- Charts have `role="img"` + labels and a list alternative nearby (ranked lists, the journal).
- 44 pt targets (64 in kids mode), Dynamic Type / Android font scale, reduce motion and haptics toggles, car mode
  (four 120 px targets) when CarPlay or Android Auto connects.

---

## 15. Server work this design assumes (flagged in the UI)

Per-user stats (`/me/stats`, listening calendar) · scoped authors/series/narrators lists · series rails annotated
with owned books · cover thumbnails + dominant/vibrant colour · up-next queue, collections, ratings (new user
state) · my devices (sign out a device) · a realtime channel for "Listening in the house" and hand-off (optional).
Older servers lack these; the UI degrades quietly (Maya's Shelf on 1.12.3 shows no API keys and no stats).

---

## 16. Token to Uniwind / shadcn mapping

| CSS variable | Utility | Used by |
|---|---|---|
| `--background / --foreground` | `bg-background text-foreground` | Screens, Text |
| `--card` | `bg-card` | Card, drawer, inputs |
| `--popover` | `bg-popover` | DropdownMenu, Dialog, bottom sheet, palette |
| `--primary` | `bg-primary text-primary-foreground` | Button default, play button, Toast, Undo chip |
| `--secondary` | `bg-secondary` | Button secondary |
| `--muted / --muted-foreground` | `bg-muted text-muted-foreground` | Skeleton, tracks, captions |
| `--accent` | `bg-accent` | Hover/pressed ghost items |
| `--border / --input / --ring` | `border-border ring-ring` | Hairlines, Input, focus |
| `--destructive` | `bg-destructive` | Sign out, delete |
| `--chart-1..5` | `fill-chart-1` | categorical chart series |
| `--seq-0..5` | `bg-seq-3` | Listening calendar |
| `--brand / --brand-ink / --brand-soft` | `bg-brand text-brand-ink` | Progress, ribbon, selection (custom) |
| `--community` | `text-community` | CC BY-SA marks, note pins (custom) |
| `--shelf-edge / --shelf-shadow` | `bg-shelf-edge` | Ledges, planks, bookends (custom) |
| `--tint / --accent2` (per book) | `style` prop | Cover-colour wash (from the server) |
| `--glass / --glass-border` | web `backdrop-blur` | iOS tab bar fallback; `expo-glass-effect` on iOS 26 |

---

## 17. Tokens in this codebase

The CSS in section 3 is the design reference. In the app:

- **Colours have one source, `src/theme/tokens.json`.** `npm run gen:tokens` (`scripts/gen-tokens.mjs`) writes:
  - the generated region of `src/global.css`: each `themes.light` / `themes.dark` token as a Uniwind theme
    variable (`--color-<name>` under `@variant light` / `@variant dark`), so `bg-background`,
    `text-muted-foreground`, `border-border`, `bg-brand`, `text-brand-ink`, `bg-topbar` ... follow the theme on
    web and native with no `dark:` pair; plus the fixed `palette` (`white`, `black`) as plain `@theme` colours;
  - `src/theme/tokens.ts`: `colors.white` / `colors.black` and `colors.light.<camelName>` /
    `colors.dark.<camelName>` (`brandInk`, `mutedForeground`, `chart1` ...) for native props. Read the current
    theme's with `useThemeColors()` (`src/theme/use-theme-colors.tsx`, a context `ThemeProvider` fills).
  - `npm test` fails on drift (`gen-tokens.mjs --check`), and `scripts/check-styles.cjs` checks through
    Uniwind's compiler that the themed variables switch on iOS and web.
- **Every token in section 3 is there**, light and dark, with the same names: the shadcn set, `subtle-foreground`,
  `border-strong`, `brand` / `brand-foreground` (dark `#ffffff`, unspecified above) / `brand-soft` /
  `brand-ink`, the status pairs, `community`, `chart-1..5`, `seq-0..5`, `shelf-edge`, and the translucent
  shell colours `shelf-shadow`, `topbar`, `glass`, `glass-border`, `overlay`. Opacity modifiers work on all of
  them (`bg-brand/10`).
- **Tailwind's default palette is switched off** (`--color-*: initial`), so `bg-gray-200` or `text-red-500`
  compiles to nothing. Use a semantic token; add one to `tokens.json` (both themes) if none fits.
- **`primary` is ink**, as in shadcn: the play button and primary buttons. The pink is `brand`; pink text is
  `brand-ink` (AA on both themes).
- **Radii and the overlay shadow have their own names** (`src/global.css` `@theme`): shadcn's `--radius`
  scale is not adopted (it would move every existing `rounded-*` class; Phase 0a decision), so the section 5
  radii are `rounded-cover` (5: covers, cover tiles and their placeholders), `rounded-control` (10:
  buttons, inputs, selects), `rounded-menu` (14: menus, popovers, toasts),
  `rounded-card` (16), `rounded-dialog` (20) and `rounded-sheet` (24); `--shadow-overlay` is the
  `shadow-overlay` utility (web two-layer, iOS one box-shadow, Android elevation). `cn()` knows these names.
- **`--wash`** is `WASH_STRENGTH` in `src/lib/cover-tint.ts` (with `coverTint`, the pure wash colours from a
  book's `cover_color`), drawn by `CoverWash` (`src/components/library/cover-wash{,.web}.tsx`: SVG radial
  gradients on native, CSS on web).
- **Not adopted yet:** `--shadow-cover*`, `--shadow-dock` and the motion tokens (covers still use
  `CoverFrame`'s `shadow-xs` / `shadow-lg`). They land with the components that need them.

### Components in this codebase

The section 8 primitives are react-native-reusables (`components.json`, `--styling-library uniwind`) in
`src/components/ui/`, restyled to Stacks, with lucide replaced by our `<Icon>` and every string translated:
`button` (variants `default` ink / `brand` / `outline` / `secondary` / `ghost` / `destructive` /
`destructive-outline` / `link`, sizes `sm` 30 / `default` 38 / `lg` 46 / `xl` 54, `title` + `icon` + `loading`
or composed children), `card`, `input` (`Input`, `Textarea`, with `label` / `error`), `dialog` (+ `DialogIcon`,
a bottom sheet on a phone, `useLayout()`), `alert-dialog` (+ the `confirm-dialog` helper; both on one
`DialogFrame`), `select`, `tabs` (the underline tabs, `scrollable`), `toggle-group` (+ the typed
`SegmentedControl`, the segmented look), `popover`, `dropdown-menu`, `switch`, `separator`, `badge`, `tooltip`,
`skeleton` (web: a CSS keyframe shimmer, the `skeleton-shimmer` utility; native: one shared clock for every
skeleton) and `kbd` (a key hint). Hand-built on primitives:
`slider`, `toast` (`toast({ title, description, action })`; the root `ShellToastHost` renders `<ToastHost>`
lifted clear of the measured bottom chrome: the tab bar and mini player on a phone, or the docked player bar), `notice`
(`Notice`, `tone` info / success / warning: the book page's and the Downloads page's) and `row-surface`
(`RowSurface` / `PressableRow`, the quiet list row). `<Text>` is the one Text: a control hands its label classes to the `<Text>` inside it
through `TextClassContext`; a primitive that renders its own text node reuses `EYEBROW_CLASS`. Overlays portal into the root `<PortalHost />` (`src/app/_layout.tsx`) and wrap in
`FullWindowOverlay` on iOS (`overlay.tsx`); they read the window's safe-area insets from `RootInsetsProvider`
(`useRootInsets` / `useOverlayInsets`), wherever they are opened from, and every Content part goes through
`withFlatStyle`. On web, Space presses any role-bearing pressable (tab, radio, switch, checkbox, option)
through one react-native-web patch (`src/lib/rnw-button-fix.web.ts`). The bottom `sheet.tsx` is still hand-rolled (its comment says why).

The covers and shelves of section 8 live in `src/components/library/`: `BookCover` (art via
`coverUrl(..., { size, version })`: the downloaded copy, else the smallest thumbnail covering the drawn
pixels when the server has `cover_sizes`, falling back to the full art; `ui/cover.tsx` draws the no-art
fallback, the title and author, or under 72 points a two-letter monogram on the title's cloth colour,
`src/lib/monogram.ts`), `CoverTile` (long-press / right-click opens the book actions, `TileActions`),
`GhostCover`, `ShelfRow` (FlashList, the ledge), `CoverGrid` / `CoverGridSkeleton` / `CoverListRow`
(sizes in `cover-layout.ts`), `QueueButton` + `useQueueActions`, `CoverWash`, the book actions
(`books/book-actions.tsx`: `BookActionsMenu`, `BookActionsButton`), the A-Z rail (`books/az-rail.tsx`),
`LibraryPicker` and the collection cards and dialogs (`collections/`); `FilterChip` / `ChipRow` are in
`ui/filter-chip.tsx`. A `scrollable` `SegmentedControl` keeps the chosen segment in view and fades the
side that has more.

Phase 2's signature pieces: the spine, bookcase and mini shelf (`src/components/series/`: `Spine`,
`Bookcase`, `MiniShelf`, `SeriesCard`, `Portrait` for authors and narrators), Home's Now card, chapter
scale, This week card and smart shelves (`src/components/home/`), the Up next drawer, sheet, queue list
and drop zone (`src/components/upnext/`), the Downloads page's storage bar, rules card and rows
(`src/components/downloads/`, with `RemoveDownloadConfirm`) and the Search screen's grouped results
(`src/components/search/`).

Phase 4's pieces: the book page (`src/components/book/`: `BookScreen`, the washed `BookHero` and its
`HeroActions`, `BookTabPanel` with the Chapters and Details tabs, the aside with `BookAbout`), the bookmark and
note pieces (`src/components/annotations/`: `AnnotationRow` as `BookmarkRow` / `NoteRow`, `AnnotationSection`,
the `TimeChip`, `LabelChip` and `LabelPicker` chips, `RowCover` and `ServerFlag`, and the editor sheet), and the
Journal (`src/components/journal/`: the Diary with its session rows and drift strips, the bookmarks and notes
lists, the export menu). `ui/notice.tsx` is the one `Notice` (above), and `ui/touch-target.ts` holds the 44 pt
rule: `slopTo44` for a rem-sized control (the player controls), `touchTarget` for a small one (a chip, a row's
icon action: a real 44 pt frame on iOS and Android, a slop on the web).

The shell's section 8 pieces live in `src/components/shell/`: the **command palette** (`command-palette.tsx`,
web only, on the Dialog primitive: a combobox with `aria-activedescendant` over a grouped listbox, 48 px
options, the match in `brand-ink` bold, key hints and the result count in the footer: Actions, Books / Continue listening, Series, Authors,
Narrators, Characters (met only, the rest counted in a note row) and Go to, from the Search screen's
model in `src/components/search/`) and the
top bar's **profile menu** (`profile-menu.tsx`, a DropdownMenu: servers with their state, Add a server,
the account, appearance; the household waits for Phase 8). The appearance items show the sun or the moon
of the appearance they switch to.

### Fonts

One family per token, because React Native has no font fallback or synthetic weights (`src/global.css` `@theme`,
loaded by `ThemeProvider` from `@expo-google-fonts/*`; web adds a system fallback stack). Bricolage ships static
weights only, so its 650-750 design weights are set semibold or bold. The Figtree and Bricolage weights hold the
splash until they load; JetBrains Mono loads alongside without holding first paint (the system mono until then).

| Class | Family | Weight |
|---|---|---|
| `font-sans` | Figtree | 400 |
| `font-sans-medium` | Figtree | 500 |
| `font-sans-semibold` | Figtree | 600 (the guide's 650) |
| `font-sans-bold` | Figtree | 700 |
| `font-display` | Bricolage Grotesque | 700 (the guide's 680-750) |
| `font-display-semibold` | Bricolage Grotesque | 600 (the guide's 650) |
| `font-mono` | JetBrains Mono | 500 |

Don't combine a font token with `font-medium` / `font-bold`: the family has one weight.

### Type roles

`<Text variant=...>` (`src/components/ui/text.tsx`) implements section 4 on Tailwind's rem steps (14 px rem on
native, 16 px on web): `display-xl`, `display`, `heading`, `title`, `body`, `muted` (body, smaller and muted),
`label`, `caption`, `eyebrow`, `mono`, `stat`. `stat` and `mono` set tabular figures. Colours are themed tokens,
so `className="text-brand-ink"` recolours a variant in both themes.

### Theme default

A new install follows the OS (`system`); an install that was already in use and never chose a theme keeps
`dark` (written once on the first launch of this version). An explicit pick always wins; an unknown stored
value reads as `dark` and is not written. The default is a step of the launch storage migration
(`migrateStorage`, `src/lib/storage-migration.ts`), which writes `defaultSchemePref` (`src/theme/scheme-pref.ts`)
only when nothing is stored, reading the existing-install signal (`hasExistingInstall`, `src/stores/session.ts`)
before `resetStaleStorage` runs; `ThemeProvider` then reads the stored value (`restoredSchemePref`).

