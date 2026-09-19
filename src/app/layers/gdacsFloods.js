import { createGdacsFloodsLayer } from '../../layers/gdacsFloods/index.js';
import { localGeoJsonServices } from '../localGeojsonServices.js';
/** Wire the GDACS flood alerts to the application overlay and context services. */
export function createApplicationGdacsFloods(options) {
  return createGdacsFloodsLayer({ services: localGeoJsonServices, ...options });
}
