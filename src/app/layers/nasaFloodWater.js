import { createNasaFloodWaterLayer } from '../../layers/nasaFloodWater/index.js';
import { governorRequestRender } from '../../renderGovernor.js';
/** Wire the NASA observed-flood overlay to the application render governor. */
export function createApplicationNasaFloodWater(options) {
  return createNasaFloodWaterLayer({ governorRequestRender, ...options });
}
