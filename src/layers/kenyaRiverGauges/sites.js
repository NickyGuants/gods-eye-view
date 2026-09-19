/**
 * @module kenyaRiverGauges/sites
 * @description The virtual gauge sites the Kenya river layer watches.
 *
 * Each site is a point on a Kenyan river where floods matter to people
 * downstream: a bridge, a town, a floodplain, a dyke. GloFAS (the Copernicus
 * global flood model Open-Meteo serves) works on a 0.05° grid, roughly 5 km,
 * so a site is a grid cell, not a physical gauge. The layer snaps each site to
 * the wettest cell in its 3×3 neighbourhood on first load (see source.js) so a
 * coordinate a few hundred metres off the channel still lands on the river.
 *
 * Coordinates are approximate river locations from public maps. `note`
 * explains why the site is watched. Pure data: no imports, no runtime work.
 */

/** @typedef {{id:string,name:string,river:string,county:string,lat:number,lon:number,note:string}} GaugeSite */

/** @type {readonly GaugeSite[]} */
export const KENYA_GAUGE_SITES = Object.freeze(
  [
    // Lake Victoria basin: the perennial national flood zones.
    {
      id: 'nzoia-budalangi',
      name: 'Nzoia at Rwambwa (Budalangi)',
      river: 'Nzoia',
      county: 'Busia',
      lat: 0.118,
      lon: 34.092,
      note: 'Dyke breaches flood Bunyala every strong-rain season.',
    },
    {
      id: 'nzoia-webuye',
      name: 'Nzoia at Webuye',
      river: 'Nzoia',
      county: 'Bungoma',
      lat: 0.616,
      lon: 34.77,
      note: 'Upstream check on the Budalangi flood wave.',
    },
    {
      id: 'nyando-ahero',
      name: 'Nyando at Ahero',
      river: 'Nyando',
      county: 'Kisumu',
      lat: -0.171,
      lon: 34.917,
      note: 'Backs up over the Kano Plains; Ahero cut off in 2020 and 2024.',
    },
    {
      id: 'sondu-miriu',
      name: 'Sondu Miriu at Sondu',
      river: 'Sondu Miriu',
      county: 'Kisumu',
      lat: -0.396,
      lon: 34.98,
      note: 'Steep Kisii-highland catchment; sharp flood peaks.',
    },
    {
      id: 'yala-yala',
      name: 'Yala at Yala town',
      river: 'Yala',
      county: 'Siaya',
      lat: 0.098,
      lon: 34.53,
      note: 'Yala swamp and the Siaya lakeshore.',
    },
    {
      id: 'kuja-migori',
      name: 'Kuja (Gucha) at Migori',
      river: 'Kuja',
      county: 'Migori',
      lat: -1.063,
      lon: 34.473,
      note: 'Lower Kuja floods Nyatike before Lake Victoria.',
    },
    {
      id: 'mara-bridge',
      name: 'Mara at New Mara Bridge',
      river: 'Mara',
      county: 'Narok',
      lat: -1.526,
      lon: 35.034,
      note: 'Mau catchment; Talek and Mara camps flooded May 2024.',
    },
    // Rift Valley: KMD-named Narok hotspots and the lake-rise basin.
    {
      id: 'ewaso-ngiro-south-narok',
      name: "Ewaso Ng'iro South at Narok town",
      river: "Ewaso Ng'iro South",
      county: 'Narok',
      lat: -1.084,
      lon: 35.867,
      note: 'KMD Aug 2026 hotspot: flash floods through Narok town centre.',
    },
    {
      id: 'perkerra-marigat',
      name: 'Perkerra at Marigat',
      river: 'Perkerra',
      county: 'Baringo',
      lat: 0.47,
      lon: 35.982,
      note: 'Feeds Lake Baringo, whose rise submerged Marigat in 2020-24.',
    },
    {
      id: 'kerio-tot',
      name: 'Kerio at Tot',
      river: 'Kerio',
      county: 'Elgeyo-Marakwet',
      lat: 0.97,
      lon: 35.66,
      note: 'Kerio Valley flash floods below the landslide-prone escarpment.',
    },
    {
      id: 'turkwel-lodwar',
      name: 'Turkwel at Lodwar',
      river: 'Turkwel',
      county: 'Turkana',
      lat: 3.119,
      lon: 35.597,
      note: 'Flash floods reach Lodwar hours after rain on the Cherangani.',
    },
    {
      id: 'malewa-naivasha',
      name: 'Malewa at Naivasha',
      river: 'Malewa',
      county: 'Nakuru',
      lat: -0.68,
      lon: 36.4,
      note: 'Main inflow to Lake Naivasha; lakeshore homes flood on lake rise.',
    },
    // Nairobi: small urban rivers, coarse at 5 km but still the ones that kill.
    {
      id: 'nairobi-river-kariobangi',
      name: 'Nairobi River at Kariobangi',
      river: 'Nairobi',
      county: 'Nairobi',
      lat: -1.2565,
      lon: 36.8955,
      note: 'Mathare joins here; Kariobangi and Dandora flooded Mar 2026.',
    },
    {
      id: 'ngong-mukuru',
      name: 'Ngong River at Mukuru',
      river: 'Ngong',
      county: 'Nairobi',
      lat: -1.3145,
      lon: 36.877,
      note: 'Kibera, South B and Mukuru sit on its floodplain.',
    },
    {
      id: 'athi-athi-river',
      name: 'Athi at Athi River town',
      river: 'Athi',
      county: 'Machakos',
      lat: -1.456,
      lon: 36.978,
      note: 'Collects every Nairobi river; Mombasa Road corridor.',
    },
    {
      id: 'athi-fourteen-falls',
      name: 'Athi at Fourteen Falls',
      river: 'Athi',
      county: 'Kiambu',
      lat: -1.083,
      lon: 37.183,
      note: 'Thika and Athi combined, heading for Tsavo and the coast.',
    },
    // Tana: the biggest river and the biggest displacement numbers.
    {
      id: 'tana-garissa',
      name: 'Tana at Garissa',
      river: 'Tana',
      county: 'Garissa',
      lat: -0.454,
      lon: 39.64,
      note: 'Town and riverine farms; 1997 and 2023 displacements.',
    },
    {
      id: 'tana-hola',
      name: 'Tana at Hola',
      river: 'Tana',
      county: 'Tana River',
      lat: -1.5,
      lon: 40.03,
      note: 'Mid-Tana floodplain settlements.',
    },
    {
      id: 'tana-garsen',
      name: 'Tana at Garsen',
      river: 'Tana',
      county: 'Tana River',
      lat: -2.273,
      lon: 40.116,
      note: 'Delta villages and the Garsen–Lamu road.',
    },
    // Ewaso Ng'iro North and the north-east.
    {
      id: 'ewaso-ngiro-north-archers-post',
      name: "Ewaso Ng'iro North at Archer's Post",
      river: "Ewaso Ng'iro North",
      county: 'Samburu',
      lat: 0.638,
      lon: 37.667,
      note: 'Floods the Isiolo–Marsabit road and Samburu lodges.',
    },
    {
      id: 'daua-mandera',
      name: 'Daua at Mandera',
      river: 'Daua',
      county: 'Mandera',
      lat: 3.937,
      lon: 41.867,
      note: 'Fed by Ethiopian highland rain; Mandera town flooded Nov 2023.',
    },
    // Coast.
    {
      id: 'galana-sabaki',
      name: 'Galana-Sabaki at Sabaki bridge',
      river: 'Galana-Sabaki',
      county: 'Kilifi',
      lat: -3.163,
      lon: 40.12,
      note: 'The Athi reaches the sea here; Malindi–Mombasa road bridge.',
    },
    {
      id: 'tsavo-tsavo',
      name: 'Tsavo at Tsavo bridge',
      river: 'Tsavo',
      county: 'Taita Taveta',
      lat: -2.98,
      lon: 38.47,
      note: 'Mombasa Road and SGR crossings.',
    },
    {
      id: 'voi-voi',
      name: 'Voi at Voi town',
      river: 'Voi',
      county: 'Taita Taveta',
      lat: -3.39,
      lon: 38.56,
      note: 'Taita Hills runoff through Voi town.',
    },
  ].map((site) => Object.freeze(site)),
);

/** Grid spacing of the GloFAS cells Open-Meteo serves, in degrees. */
export const GLOFAS_CELL_DEG = 0.05;
