import { LocaleType, Tools } from '@univerjs/core';

// Univer requires the `locales` map to actually be populated for the chosen
// LocaleType. Passing only `locale: EN_US` without strings makes the
// LocaleService throw "Locale not initialized" the moment any plugin asks
// for a string — which is on first render. Symptom: black screen.
//
// Each Univer package ships its own string table per locale. We import the
// EN_US slice from every package we register and deep-merge them; the merge
// order doesn't matter because no two packages share keys.
//
// Pattern mirrors ../sheet/apps/web/src/locale.ts. Same `deepMerge` helper.

import UniverDocsUIEnUS from '@univerjs/docs-ui/locale/en-US';
import UniverSlidesUIEnUS from '@univerjs/slides-ui/locale/en-US';
import UniverUIEnUS from '@univerjs/ui/locale/en-US';

const enUS = Tools.deepMerge({}, UniverDocsUIEnUS, UniverSlidesUIEnUS, UniverUIEnUS);

export const LOCALES = {
  [LocaleType.EN_US]: enUS,
};
