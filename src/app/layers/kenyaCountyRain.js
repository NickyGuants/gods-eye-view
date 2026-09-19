import { createKenyaCountyRainLayer } from '../../layers/kenyaCountyRain/index.js';
import { localGeoJsonServices } from '../localGeojsonServices.js';
/** Wire the Kenya county rainfall layer to the application services. */
export function createApplicationKenyaCountyRain(options) {
  return createKenyaCountyRainLayer({
    services: localGeoJsonServices,
    ...options,
  });
}
