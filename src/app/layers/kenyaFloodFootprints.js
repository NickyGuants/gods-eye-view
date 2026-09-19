import { createKenyaFloodFootprintsLayer } from '../../layers/kenyaFloodFootprints/index.js';
import { localGeoJsonServices } from '../localGeojsonServices.js';
/** Wire the 3D flood footprints to the application overlay and render services. */
export function createApplicationKenyaFloodFootprints(options) {
  return createKenyaFloodFootprintsLayer({
    services: localGeoJsonServices,
    ...options,
  });
}
