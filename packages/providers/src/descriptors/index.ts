import { discord } from './discord';
import { fourthwall } from './fourthwall';
import { gumroad } from './gumroad';
import { itchio } from './itchio';
import { jinxxy } from './jinxxy';
import { lemonsqueezy } from './lemonsqueezy';
import { manual } from './manual';
import { patreon } from './patreon';
import { payhip } from './payhip';
import { vrchat } from './vrchat';

/**
 * All provider descriptor inputs, assembled from per-provider files.
 * To add a new provider: create a descriptor file in this directory,
 * import it here, and add it to the array.
 */
export const ALL_DESCRIPTOR_INPUTS = [
  discord,
  gumroad,
  jinxxy,
  lemonsqueezy,
  manual,
  patreon,
  fourthwall,
  itchio,
  payhip,
  vrchat,
] as const;
