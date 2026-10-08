import { ADDRESS_IN_USE_LABEL } from '@/api/address-route';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import it_ from '@/i18n/locales/it.json';
import pt from '@/i18n/locales/pt.json';

const LOCALES = { en, de, fr, es, it: it_, pt };

const lookup = (bundle: object, key: string): unknown =>
  key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundle);

describe('AddressesCard "in use" line copy', () => {
  // The card joins the in-use label and `addresses.switches` with a space: the device
  // pass read "Using your home address The app switches..." as one run-on sentence.
  it.each(Object.entries(LOCALES))('ends every in-use label as a sentence in %s', (_, bundle) => {
    for (const key of Object.values(ADDRESS_IN_USE_LABEL)) {
      expect(lookup(bundle, key)).toMatch(/[.!?]$/);
    }
    expect(lookup(bundle, 'addresses.switches')).toMatch(/[.!?]$/);
  });
});
