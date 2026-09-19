import { createKenyaRiverGaugesLayer } from '../../layers/kenyaRiverGauges/index.js';
import { localGeoJsonServices } from '../localGeojsonServices.js';
/** Wire the Kenya river gauges to the application overlay and context services. */
export function createApplicationKenyaRiverGauges(options) {
  return createKenyaRiverGaugesLayer({
    services: localGeoJsonServices,
    ...options,
  });
}
