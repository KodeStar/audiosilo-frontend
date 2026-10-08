import type { TFunction } from 'i18next';

import { formatCount, formatDurationOrZero, formatTimeOfDay } from '@/lib/format';

import { roundHours, type YearCard } from './year-model';

/**
 * The words on each story card, built once per card so the card, its thumbnail and what
 * a screen reader hears say the same thing (`cardSpeech`).
 */

export type CopyContext = {
  /** `YYYY`. */
  year: string;
  /** The listener's name on that server, when known. */
  userName?: string;
  /** The server the story is made on. */
  serverName: string;
};

export type CardCopy = {
  /** The small caps line at the top. */
  kicker: string;
  /** A heading (Bricolage). */
  title?: string;
  /** The big figure, and the words under it. */
  big?: string;
  unit?: string;
  /** Running lines, in order. */
  body: string[];
  /** The listening clock's centre. */
  clock?: { value: string; caption: string };
  /** The author and series rows. */
  rows?: { label: string; name: string; detail: string }[];
  /** The summary card's figures. */
  figures?: { value: string; label: string }[];
  /** The thumbnail's label. */
  thumb: string;
};

/** "36 hours", or "1h 20m" under two hours (a rounded "1 hour" would overstate it). */
export function listenTime(seconds: number, t: TFunction): string {
  if (seconds >= 7200) return t('year.hoursLong', { count: roundHours(seconds) });
  return formatDurationOrZero(seconds);
}

/** "22:00" / "10:00 PM": an hour of the day in the reader's clock. */
export function hourLabel(hour: number): string {
  return formatTimeOfDay(`${String(hour).padStart(2, '0')}:00`);
}

const books = (n: number, t: TFunction) => t('year.booksCount', { count: n });

export function cardCopy(card: YearCard, ctx: CopyContext, t: TFunction): CardCopy {
  switch (card.kind) {
    case 'hours': {
      const hours = roundHours(card.listened);
      const body: string[] = [];
      if (card.wholeDays > 0) body.push(t('year.card.hours.days', { count: card.wholeDays }));
      body.push(
        t('year.card.hours.spread', {
          sessions: t('year.sessionsCount', { count: card.sessions }),
          books: books(card.books, t),
        }),
      );
      if (card.estimated >= 60) {
        body.push(
          t('year.card.hours.estimated', {
            duration: listenTime(card.estimated, t),
            server: ctx.serverName,
          }),
        );
      }
      return {
        kicker: t('year.card.hours.kicker', { server: ctx.serverName }),
        title: ctx.userName
          ? t('year.card.hours.leadNamed', { name: ctx.userName, year: ctx.year })
          : t('year.card.hours.lead', { year: ctx.year }),
        big: formatCount(hours),
        unit: t('year.card.hours.unit', { count: hours }),
        body,
        thumb: t('year.hoursLong', { count: hours }),
      };
    }
    case 'books': {
      const body: string[] = [];
      if (card.goal) {
        const left = card.goal - card.finished;
        body.push(
          left > 0
            ? t('year.card.books.goalBehind', { count: left, goal: card.goal })
            : t('year.card.books.goalReached', { goal: card.goal }),
        );
      }
      if (card.spines.length > 0) body.push(t('year.card.books.tower'));
      return {
        kicker: t('year.card.books.kicker'),
        big: formatCount(card.finished),
        unit: t('year.card.books.unit', { count: card.finished }),
        body,
        thumb: books(card.finished, t),
      };
    }
    case 'book':
      return {
        kicker: t('year.card.book.kicker'),
        title: card.book.title,
        body: [
          ...(card.book.author ? [t('year.card.book.by', { author: card.book.author })] : []),
          t('year.card.book.time', { duration: listenTime(card.book.listened, t) }),
        ],
        thumb: t('year.card.book.thumb'),
      };
    case 'voice': {
      const [a, b] = card.runnersUp;
      const then = b
        ? t('year.card.voice.thenTwo', {
            a: a.name,
            aTime: listenTime(a.listened, t),
            b: b.name,
            bTime: listenTime(b.listened, t),
          })
        : a
          ? t('year.card.voice.thenOne', { a: a.name, aTime: listenTime(a.listened, t) })
          : null;
      return {
        kicker: t('year.card.voice.kicker'),
        title: t('year.card.voice.title', {
          duration: listenTime(card.narrator.listened, t),
          name: card.narrator.name,
        }),
        body: then ? [then] : [],
        thumb: t('year.card.voice.thumb'),
      };
    }
    case 'clock': {
      const time = hourLabel(card.peak);
      return {
        kicker: t('year.card.clock.kicker'),
        title: t(`year.card.clock.part.${card.part}`),
        body: [t('year.card.clock.peak', { time })],
        clock: { value: time, caption: t('year.card.clock.caption') },
        thumb: t('year.card.clock.thumb'),
      };
    }
    case 'streak': {
      const body: string[] = [];
      if (card.current !== null && card.current > 0) {
        body.push(
          card.current >= card.longest
            ? t('year.card.streak.going')
            : t('year.card.streak.current', { count: card.current }),
        );
      }
      return {
        kicker: t('year.card.streak.kicker'),
        big: formatCount(card.longest),
        unit: t('year.card.streak.unit', { count: card.longest }),
        body,
        thumb: t('year.card.streak.thumb', { count: card.longest }),
      };
    }
    case 'people': {
      const rows: NonNullable<CardCopy['rows']> = [];
      for (const [label, who] of [
        [t('year.card.people.author'), card.author],
        [t('year.card.people.series'), card.series],
      ] as const) {
        if (!who) continue;
        rows.push({
          label,
          name: who.name,
          detail: t('year.card.people.detail', {
            duration: listenTime(who.listened, t),
            books: books(who.books, t),
          }),
        });
      }
      return {
        kicker: t('year.card.people.kicker'),
        body: [],
        rows,
        thumb: card.author ? t('year.card.people.author') : t('year.card.people.series'),
      };
    }
    case 'summary': {
      const hours = roundHours(card.listened);
      const figures = [
        hours > 0
          ? { value: formatCount(hours), label: t('year.card.summary.hours', { count: hours }) }
          : { value: listenTime(card.listened, t), label: t('year.card.summary.listened') },
        {
          value: formatCount(card.finished),
          label: t('year.card.summary.finished', { count: card.finished }),
        },
        card.longest >= 2
          ? {
              value: formatCount(card.longest),
              label: t('year.card.summary.streak', { count: card.longest }),
            }
          : null,
        {
          value: formatCount(card.books),
          label: t('year.card.summary.books', { count: card.books }),
        },
      ].filter((f): f is { value: string; label: string } => f !== null);
      return {
        kicker: ctx.userName
          ? t('year.card.summary.kickerNamed', { year: ctx.year, name: ctx.userName })
          : t('year.card.summary.kicker', { year: ctx.year }),
        body: [],
        figures,
        thumb: t('year.card.summary.thumb'),
      };
    }
  }
}

/** A sentence ends with its own stop, so joined lines read as sentences (no ". ."). */
function sentence(s: string): string {
  return /[.!?。:]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;
}

/** Everything a card says, as one text for a screen reader (the drawing is decorative). */
export function cardSpeech(copy: CardCopy): string {
  const parts = [
    copy.kicker,
    copy.title,
    copy.big ? `${copy.big} ${copy.unit ?? ''}` : undefined,
    ...(copy.rows ?? []).map((r) => `${r.label}: ${r.name}, ${r.detail}`),
    ...(copy.figures ?? []).map((f) => `${f.value} ${f.label}`),
    ...copy.body,
  ];
  return parts
    .filter((p): p is string => !!p && p.trim() !== '')
    .map(sentence)
    .join(' ');
}
