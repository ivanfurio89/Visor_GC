#!/usr/bin/env node
/* =========================================================================
   fetch-data.mjs — descarga AEMET + GRAFCAN y escribe data/stations.json
   -------------------------------------------------------------------------
   Se ejecuta desde GitHub Actions (.github/workflows/update-data.yml) con
   las claves como variables de entorno AEMET_API_KEY / GRAFCAN_API_KEY
   (GitHub Secrets) — nunca en el código ni en el repo.

   Es el mismo modelo de datos y la misma lógica de mapeo que index.html
   (fetchAemet/fetchGrafcan), portada a Node: mismo bbox, mismo dedupe/series
   de AEMET, mismo grafcanClassify/grafcanRank/grafcanToDisplay de GRAFCAN.
   El frontend, si encuentra data/stations.json, lo usa directamente (sin
   claves, sin CORS, sin el WAF de AEMET desde el navegador).
   ========================================================================= */
import { writeFile, mkdir } from 'node:fs/promises';

const AEMET_API_KEY = process.env.AEMET_API_KEY || '';
const GRAFCAN_API_KEY = process.env.GRAFCAN_API_KEY || '';

const GC_BBOX = { latMin: 27.65, latMax: 28.23, lonMin: -15.95, lonMax: -15.30 };

/* ---------------------------------------------------------------------
   AEMET OpenData — igual que en index.html: 2 pasos, ISO-8859-15, filtro
   por bbox, agrupado por idema en series + último valor.
--------------------------------------------------------------------- */
async function fetchAemet(apiKey) {
  const base = 'https://opendata.aemet.es/opendata/api/observacion/convencional/todas';
  const step1 = await fetch(base + '?api_key=' + encodeURIComponent(apiKey));
  if (!step1.ok) throw new Error('petición inicial falló (' + step1.status + ')');
  const step1json = await step1.json();
  if (!step1json.datos) throw new Error('respuesta sin "datos" — revisa la api_key');

  const step2 = await fetch(step1json.datos);
  if (!step2.ok) throw new Error('no se pudo descargar el JSON de datos (' + step2.status + ')');
  const raw = JSON.parse(new TextDecoder('iso-8859-15').decode(await step2.arrayBuffer()));

  const gc = raw.filter(s => s.lat >= GC_BBOX.latMin && s.lat <= GC_BBOX.latMax &&
                             s.lon >= GC_BBOX.lonMin && s.lon <= GC_BBOX.lonMax);
  const porId = new Map();
  for (const s of gc) { if (!porId.has(s.idema)) porId.set(s.idema, []); porId.get(s.idema).push(s); }

  return [...porId.values()].map(recs => {
    recs.sort((a, b) => (a.fint || '').localeCompare(b.fint || ''));
    const last = recs[recs.length - 1];
    const series = { ta: [], hr: [], vv: [], dv: [], prec: [] };
    for (const r of recs) {
      const t = Date.parse(r.fint); if (isNaN(t)) continue;
      if (r.ta != null) series.ta.push({ t, v: r.ta });
      if (r.hr != null) series.hr.push({ t, v: r.hr });
      if (r.vv != null) series.vv.push({ t, v: +(r.vv * 3.6).toFixed(1) });
      if (r.dv != null) series.dv.push({ t, v: r.dv });
      if (r.prec != null) series.prec.push({ t, v: r.prec });
    }
    return {
      id: 'aemet-' + last.idema,
      name: last.ubi || last.idema,
      lat: last.lat, lon: last.lon,
      source: 'AEMET',
      ta: last.ta ?? null,
      hr: last.hr ?? null,
      vv: (last.vv != null) ? +(last.vv * 3.6).toFixed(1) : null,
      dv: last.dv ?? null,
      prec: last.prec ?? null,
      fint: last.fint ?? null,
      series,
    };
  });
}

/* ---------------------------------------------------------------------
   GRAFCAN — igual que en index.html: things+locations, filtro por bbox,
   observations_last por thing, clasificación por nombre (avg/acc).
--------------------------------------------------------------------- */
const GRAFCAN_API = 'https://sensores.grafcan.es/api/v1.0/';

async function grafcanGetAll(url, apiKey, { maxPages = 40 } = {}) {
  const headers = { accept: 'application/json', Authorization: 'Api-Key ' + apiKey };
  let out = [], next = url, pages = 0;
  while (next && pages < maxPages) {
    const resp = await fetch(next, { headers });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} en ${next} — ${text.slice(0, 160)}`);
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error('respuesta no-JSON en ' + next); }
    const items = Array.isArray(json) ? json : (json.results || json.value || []);
    out = out.concat(items);
    next = (json && json.next) || null;
    pages++;
  }
  return out;
}
function grafcanId(ref) {
  if (ref == null) return null;
  if (typeof ref === 'object') return ref.id ?? ref.pk ?? null;
  const m = String(ref).match(/\/(\d+)\/?$/);
  return m ? +m[1] : null;
}
function grafcanCoords(loc) {
  let g = loc && loc.location;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  if (!g) return null;
  const coords = g.coordinates || (g.geometry && g.geometry.coordinates);
  if (Array.isArray(coords) && coords.length >= 2 && isFinite(coords[0]) && isFinite(coords[1])) {
    return { lon: +coords[0], lat: +coords[1] };
  }
  return null;
}
const grafcanNorm = s => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const VAR_MATCHERS = [
  { key: 'dv', re: /wind.*dir|direcc.*(viento|wind)/ },
  { key: 'vv', re: /wind.*speed|veloc.*viento|(^|\W)viento(\W|$)/ },
  { key: 'ta', re: /air.*temp|temperatura/ },
  { key: 'hr', re: /humid|humedad/ },
  { key: 'prec', re: /precip|rain|lluvia|pluviom/ },
];
function grafcanClassify(text) {
  const t = grafcanNorm(text);
  for (const m of VAR_MATCHERS) if (m.re.test(t)) return m.key;
  return null;
}
function grafcanRank(text) {
  const t = grafcanNorm(text);
  if (/\bavg\b|\(avg|media|medio/.test(t)) return 3;
  if (/\bacc\b|\(acc|accumul|acumul|total/.test(t)) return 3;
  if (/\bmax\b|\bmin\b|sdev|racha|gust/.test(t)) return 1;
  return 2;
}
function grafcanToDisplay(key, value, unitSymbol) {
  if (value == null || isNaN(value)) return null;
  if (key === 'vv' && /m\/?s/i.test(unitSymbol || '')) return +(value * 3.6).toFixed(1);
  return +value;
}

async function fetchGrafcan(apiKey) {
  const inBBox = (lat, lon) =>
    lat >= GC_BBOX.latMin && lat <= GC_BBOX.latMax && lon >= GC_BBOX.lonMin && lon <= GC_BBOX.lonMax;

  const [things, locations] = await Promise.all([
    grafcanGetAll(GRAFCAN_API + 'things/?page_size=1000', apiKey),
    grafcanGetAll(GRAFCAN_API + 'locations/?page_size=1000', apiKey),
  ]);

  const locMeta = new Map();
  for (const loc of locations) {
    const c = grafcanCoords(loc);
    if (c) locMeta.set(loc.id, { ...c, name: loc.name || null });
  }

  const gcThings = [];
  for (const th of things) {
    let loc = null;
    for (const locUrl of (th.location_set || [])) {
      const m = locMeta.get(grafcanId(locUrl));
      if (m) { loc = m; break; }
    }
    if (!loc && th.properties) {
      const p = th.properties;
      const lat = +(p.lat ?? p.latitude ?? p.latitud), lon = +(p.lon ?? p.lng ?? p.longitude ?? p.longitud);
      if (isFinite(lat) && isFinite(lon)) loc = { lat, lon, name: null };
    }
    if (loc && inBBox(loc.lat, loc.lon)) gcThings.push({ th, loc });
  }

  const H = { accept: 'application/json', Authorization: 'Api-Key ' + apiKey };
  return Promise.all(gcThings.map(async ({ th, loc }) => {
    const station = {
      id: 'grafcan-' + th.id,
      name: loc.name || th.name || ('Estación ' + th.id),
      lat: loc.lat, lon: loc.lon,
      source: 'GRAFCAN',
      ta: null, hr: null, vv: null, dv: null, prec: null, fint: null,
      _rank: {},
    };
    try {
      const r = await fetch(GRAFCAN_API + 'observations_last/?thing=' + th.id, { headers: H });
      if (r.ok) {
        const data = await r.json();
        const obs = (data && data.observations) || [];
        for (const o of obs) {
          const key = grafcanClassify(o.name);
          if (!key || o.value == null) continue;
          const rank = grafcanRank(o.name);
          if (rank < (station._rank[key] ?? 0)) continue;
          station[key] = grafcanToDisplay(key, o.value, o.unitOfMeasurement);
          station._rank[key] = rank;
          station.fint = station.fint || o.resultTime || null;
        }
      }
    } catch (_) { /* estación sin dato si falla; sigue visible */ }
    delete station._rank;
    return station;
  }));
}

/* ---------------------------------------------------------------------
   main
--------------------------------------------------------------------- */

/* ---------------------------------------------------------------------
   Productos de imagen de AEMET (radar, riesgo de incendios) — mismo patrón
   de 2 pasos, pero aquí descargamos la IMAGEN en bruto (no JSON) y los
   metadatos, y los dejamos como ficheros estáticos. Esto es justo lo que
   evita el problema del WAF de AEMET colgando el fetch desde el navegador:
   la petición la hace el runner de GitHub, no el cliente.
--------------------------------------------------------------------- */
function extFromContentType(ct) {
  if (/gif/i.test(ct || '')) return 'gif';
  if (/jpe?g/i.test(ct || '')) return 'jpg';
  return 'png';
}

async function fetchAemetImageProduct(apiKey, path) {
  const base = 'https://opendata.aemet.es/opendata/api/' + path;
  const step1 = await fetch(base + '?api_key=' + encodeURIComponent(apiKey));
  if (!step1.ok) throw new Error('petición inicial falló (' + step1.status + ')');
  const j = await step1.json();
  if (!j.datos) throw new Error('sin "datos" (estado ' + (j.estado ?? '?') + ')');

  const imgResp = await fetch(j.datos);
  if (!imgResp.ok) throw new Error('no se pudo descargar la imagen (' + imgResp.status + ')');
  const contentType = imgResp.headers.get('content-type') || 'image/png';
  const image = Buffer.from(await imgResp.arrayBuffer());

  let metadatos = null;
  if (j.metadatos) {
    try {
      const mr = await fetch(j.metadatos);
      if (mr.ok) metadatos = await mr.json();
    } catch (_) { /* opcional: si falla, seguimos sin metadatos */ }
  }
  return { image, ext: extFromContentType(contentType), metadatos };
}

// Descarga un producto-imagen y escribe data/<slug>.<ext> + data/<slug>-meta.json.
async function guardarProductoImagen(apiKey, path, slug, sources) {
  try {
    const { image, ext, metadatos } = await fetchAemetImageProduct(apiKey, path);
    const file = `${slug}.${ext}`;
    await writeFile(`data/${file}`, image);
    await writeFile(`data/${slug}-meta.json`, JSON.stringify({
      generatedAt: new Date().toISOString(), file, metadatos,
    }, null, 2));
    sources[slug] = { ok: true, bytes: image.length };
    console.log(`${slug}: imagen guardada (${image.length} bytes, data/${file})`);
  } catch (e) {
    sources[slug] = { ok: false, error: e.message };
    console.error(`${slug} error:`, e.message);
  }
}

async function main() {
  if (!AEMET_API_KEY && !GRAFCAN_API_KEY) {
    console.error('Faltan AEMET_API_KEY / GRAFCAN_API_KEY como variables de entorno.');
    process.exit(1);
  }

  const stations = [];
  const sources = {};

  if (AEMET_API_KEY) {
    try {
      const s = await fetchAemet(AEMET_API_KEY);
      stations.push(...s);
      sources.aemet = { ok: true, count: s.length };
      console.log(`AEMET: ${s.length} estaciones`);
    } catch (e) {
      sources.aemet = { ok: false, error: e.message };
      console.error('AEMET error:', e.message);
    }
  }
  if (GRAFCAN_API_KEY) {
    try {
      const s = await fetchGrafcan(GRAFCAN_API_KEY);
      stations.push(...s);
      sources.grafcan = { ok: true, count: s.length };
      console.log(`GRAFCAN: ${s.length} estaciones`);
    } catch (e) {
      sources.grafcan = { ok: false, error: e.message };
      console.error('GRAFCAN error:', e.message);
    }
  }

  await mkdir('data', { recursive: true });

  if (AEMET_API_KEY) {
    await guardarProductoImagen(AEMET_API_KEY, 'red/radar/regional/lpa', 'radar', sources);
    await guardarProductoImagen(AEMET_API_KEY, 'incendios/mapasriesgo/estimado/area/c', 'riesgo-incendios', sources);
  }

  await writeFile('data/stations.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    sources,
    stations,
  }, null, 2));
  console.log(`Escritas ${stations.length} estaciones en data/stations.json`);

  // Si TODAS las fuentes con clave fallaron, marcamos el job como fallido.
  const configuradas = Object.keys(sources);
  if (configuradas.length && configuradas.every(k => !sources[k].ok)) {
    process.exit(1);
  }
}

export { fetchAemet, fetchGrafcan, grafcanClassify, grafcanRank, grafcanToDisplay, grafcanId, grafcanCoords, GC_BBOX, main, fetchAemetImageProduct };

// Solo ejecuta main() si se invoca directamente (node fetch-data.mjs), no al
// importar las funciones desde un test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
