import {
  createOpenSkySource,
  createAdsbLolSource,
  createAisStreamSource,
} from '../sources/live/standalone.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createTransitSource } from '../layers/transit/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createInstallationSource } from '../layers/installations/source.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createLaunchSource } from '../layers/launches/source.js';
import { createOverpassAlprSource } from '../layers/alpr/source.js';
import { createFirmsSource } from '../layers/firms/source.js';
import { createOpenMeteoFloodSource } from '../layers/kenyaRiverGauges/source.js';
import { createOpenMeteoRainSource } from '../layers/kenyaCountyRain/source.js';
import { createGdacsFloodSource } from '../layers/gdacsFloods/source.js';
import { createReferenceSources } from '../sources/reference.js';
export { createReferenceSources as createStandaloneReferenceSources } from '../sources/reference.js';

/** Select standalone providers without starting their acquisition. */
export function createStandaloneLayerSources() {
  return {
    ...createReferenceSources(),
    flights: createOpenSkySource(),
    military: createAdsbLolSource(),
    vessels: createAisStreamSource({
      apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/ais-live',
    }),
    cctv: createCctvSource(),
    radio: createRadioSource(),
    traffic: createTrafficSource(),
    transit: createTransitSource(),
    bikeshare: createBikeshareSource(),
    installations: createInstallationSource(),
    satellites: createSatelliteSource(),
    launches: createLaunchSource(),
    alpr: createOverpassAlprSource(),
    firms: createFirmsSource(),
    kenyaRiverGauges: createOpenMeteoFloodSource({
      cache: standaloneSnapCache(),
    }),
    kenyaCountyRain: createOpenMeteoRainSource(),
    gdacsFloods: createGdacsFloodSource(),
  };
}

/**
 * A tolerant string cache over localStorage for the river-gauge snap step.
 * Absent or blocked storage (private windows, tests) yields `null`, and the
 * source then re-probes on every session instead of failing.
 */
function standaloneSnapCache() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
    };
  } catch {
    return null;
  }
}
