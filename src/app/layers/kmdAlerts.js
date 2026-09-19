import { createKmdAlertsLayer } from '../../layers/kmdAlerts/index.js';
import { localGeoJsonServices } from '../localGeojsonServices.js';
/** Wire the KMD CAP warnings to the application overlay and context services. */
export function createApplicationKmdAlerts(options) {
  return createKmdAlertsLayer({ services: localGeoJsonServices, ...options });
}
