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
const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY || ''; // opcional: focos activos NASA FIRMS

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// AEMET corta la conexión de vez en cuando (SocketError: other side closed),
// de forma intermitente y no ligada a una ruta concreta. Reintentamos con
// espera creciente antes de rendirnos.
async function fetchConReintento(url, intentos = 3) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    try { return await fetch(url); }
    catch (e) {
      ultimoError = e;
      if (i < intentos - 1) await sleep(1500 * (i + 1));
    }
  }
  throw ultimoError;
}

async function fetchAemetImageProduct(apiKey, path) {
  const base = 'https://opendata.aemet.es/opendata/api/' + path;
  let step1;
  try { step1 = await fetchConReintento(base + '?api_key=' + encodeURIComponent(apiKey)); }
  catch (e) { throw new Error('paso 1 (' + path + '): ' + e.message + (e.cause ? ' — causa: ' + e.cause : '')); }
  if (!step1.ok) throw new Error('petición inicial falló (' + step1.status + ')');
  const j = await step1.json();
  if (!j.datos) throw new Error('sin "datos" (estado ' + (j.estado ?? '?') + (j.descripcion ? ': ' + j.descripcion : '') + ')');

  let imgResp;
  try { imgResp = await fetchConReintento(j.datos); }
  catch (e) { throw new Error('descarga de imagen: ' + e.message + (e.cause ? ' — causa: ' + e.cause : '')); }
  if (!imgResp.ok) throw new Error('no se pudo descargar la imagen (' + imgResp.status + ')');
  const contentType = imgResp.headers.get('content-type') || 'image/png';
  const image = Buffer.from(await imgResp.arrayBuffer());

  let metadatos = null;
  if (j.metadatos) {
    try {
      const mr = await fetch(j.metadatos);
      // Igual que el resto de AEMET, este JSON viene en ISO-8859-15, no UTF-8
      // (si no, "descripción" sale como "descripci�n").
      if (mr.ok) metadatos = JSON.parse(new TextDecoder('iso-8859-15').decode(await mr.arrayBuffer()));
    } catch (_) { /* opcional: si falla, seguimos sin metadatos */ }
  }
  return { image, ext: extFromContentType(contentType), metadatos };
}

// Descarga un producto-imagen y escribe data/<slug>.<ext> + data/<slug>-meta.json.
// Admite varias rutas candidatas (se prueban en orden; se queda con la 1ª que
// funcione) — útil mientras no sabemos con certeza cuál da datos de verdad.
async function guardarProductoImagen(apiKey, paths, slug, sources) {
  const intentos = [];
  for (const path of (Array.isArray(paths) ? paths : [paths])) {
    try {
      const { image, ext, metadatos } = await fetchAemetImageProduct(apiKey, path);
      const file = `${slug}.${ext}`;
      await writeFile(`data/${file}`, image);
      await writeFile(`data/${slug}-meta.json`, JSON.stringify({
        generatedAt: new Date().toISOString(), path, file, metadatos,
      }, null, 2));
      sources[slug] = { ok: true, bytes: image.length, path, intentos };
      console.log(`${slug}: imagen guardada (${image.length} bytes, data/${file}, ruta: ${path})`);
      return;
    } catch (e) {
      intentos.push({ path, error: e.message });
      console.error(`${slug}: falló ${path} — ${e.message}`);
    }
  }
  sources[slug] = { ok: false, intentos };
}

/* ---------------------------------------------------------------------
   NASA FIRMS — focos de calor activos (VIIRS). API "area" en CSV:
   /api/area/csv/{MAP_KEY}/{source}/{west,south,east,north}/{días}
   Combinamos 3 satélites VIIRS (SNPP/NOAA-20/NOAA-21) para mejor cobertura
   temporal sobre un área tan pequeña como Gran Canaria. confidence viene
   como letra (l/n/h = baja/nominal/alta) en VIIRS, no como %.
--------------------------------------------------------------------- */
const FIRMS_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];
const FIRMS_DIAS = 2; // ventana de días hacia atrás (NRT tiene ~3h de latencia)

function parseCsv(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return []; // solo cabecera o vacío -> sin focos
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

async function fetchFirmsSource(mapKey, source, bbox, dias) {
  const area = `${bbox.lonMin},${bbox.latMin},${bbox.lonMax},${bbox.latMax}`;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${source}/${area}/${dias}`;
  const r = await fetchConReintento(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  // Errores de FIRMS vienen como texto plano ("Invalid MAP_KEY", límite, etc.)
  if (!text.includes(',')) throw new Error('respuesta inesperada: ' + text.slice(0, 150));
  return parseCsv(text)
    .map(row => ({
      lat: +row.latitude, lon: +row.longitude,
      confianza: row.confidence ?? null,
      frp: row.frp != null && row.frp !== '' ? +row.frp : null,
      fecha: row.acq_date ?? null, hora: row.acq_time ?? null,
      satelite: row.satellite || source, diaNoche: row.daynight ?? null,
    }))
    .filter(p => isFinite(p.lat) && isFinite(p.lon));
}

async function fetchFirms(mapKey) {
  const out = [];
  for (const source of FIRMS_SOURCES) {
    try {
      out.push(...await fetchFirmsSource(mapKey, source, GC_BBOX, FIRMS_DIAS));
    } catch (e) {
      console.error(`FIRMS ${source} error:`, e.message);
    }
  }
  return out;
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
    // Código correcto confirmado en el Swagger de AEMET: "ca" = Canarias.
    // ("lpa"/"gc" eran una suposición de la web pública, no de esta API).
    await guardarProductoImagen(AEMET_API_KEY, ['red/radar/regional/ca'], 'radar', sources);
    // "previsto/dia/1" es la que de verdad tiene datos ahora mismo (probado);
    // dejamos las otras como reserva por si el producto disponible cambia.
    await guardarProductoImagen(AEMET_API_KEY, [
      'incendios/mapasriesgo/previsto/dia/1/area/c',
      'incendios/mapasriesgo/previsto/dia/0/area/c',
      'incendios/mapasriesgo/estimado/area/c',
    ], 'riesgo-incendios', sources);
  }

  if (FIRMS_MAP_KEY) {
    try {
      const focos = await fetchFirms(FIRMS_MAP_KEY);
      await writeFile('data/firms.json', JSON.stringify({
        generatedAt: new Date().toISOString(), diasVentana: FIRMS_DIAS, focos,
      }, null, 2));
      sources.firms = { ok: true, count: focos.length };
      console.log(`FIRMS: ${focos.length} focos activos`);
    } catch (e) {
      sources.firms = { ok: false, error: e.message };
      console.error('FIRMS error:', e.message);
    }
  } else {
    console.log('FIRMS: FIRMS_MAP_KEY no configurada, se omite (opcional).');
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

export { fetchAemet, fetchGrafcan, grafcanClassify, grafcanRank, grafcanToDisplay, grafcanId, grafcanCoords, GC_BBOX, main, fetchAemetImageProduct, parseCsv, fetchFirmsSource, fetchFirms };

// Solo ejecuta main() si se invoca directamente (node fetch-data.mjs), no al
// importar las funciones desde un test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
