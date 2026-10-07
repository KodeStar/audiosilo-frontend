import { YouHub } from '@/components/you/you-hub';

// /you[?section=stats|year|journal|settings|account] (youHref): the Me tab's root, the You
// hub. Its `section` (and the Journal's `tab`) are the root's own params
// (`Destination.rootParams`), kept when the root comes back into focus.
export default YouHub;
