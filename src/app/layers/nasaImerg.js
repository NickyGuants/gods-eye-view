import { createNasaImergLayer } from '../../layers/nasaImerg/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
/** Wire the NASA IMERG rainfall overlay to the application render governor. */
export function createApplicationNasaImerg(options) {
  return createNasaImergLayer({ governorRequestRender, ...options });
}
