# Visor de Estaciones Meteorológicas · Gran Canaria

Visor web ligero (Leaflet, sin frameworks) de la red de estaciones
meteorológicas de Gran Canaria. Pensado como base del futuro **visor
operativo de vigilancia de incendios** del Cabildo de Gran Canaria.

Un único archivo (`index.html`) listo para publicarse en **GitHub Pages**.

## Fuentes de datos

| Fuente | Endpoint | Notas |
|---|---|---|
| **AEMET OpenData** | `observacion/convencional/todas` | Devuelve toda España; se filtra al bounding box de Gran Canaria. Petición en 2 pasos (endpoint → URL en `datos` → JSON). |
| **GRAFCAN Sensores** (Gobierno de Canarias) | `sensores.grafcan.es/api/v1.0/` | API tipo OGC SensorThings sobre Django REST Framework. Los valores se obtienen cruzando `things` + `locations` + `datastreams` + `observations_last`. |

## Backend (GitHub Actions) — datos precomputados

`scripts/fetch-data.mjs` es la misma lógica de descarga/mapeo que usa el
visor (AEMET + GRAFCAN), portada a Node. `.github/workflows/update-data.yml`
lo ejecuta **cada 15 min** con las claves como *Secrets* del repo y escribe
`data/stations.json` (commit automático).

El visor, al arrancar, intenta cargar `data/stations.json` (`intentarCargaEstatica()`)
**antes** de pedir claves. Si existe, lo usa directamente: sin claves en el
navegador, sin CORS, sin el WAF de AEMET. Si no existe (repo recién clonado,
`file://` antes de la primera ejecución del workflow), el visor sigue
funcionando igual que siempre con el modo de claves en vivo.

Para activarlo en tu repo:
1. *Settings → Secrets and variables → Actions* → crea `AEMET_API_KEY` y
   `GRAFCAN_API_KEY`.
2. *Settings → Actions → General → Workflow permissions* → **Read and write
   permissions** (para que el workflow pueda hacer commit de `data/`).
3. Lánzalo una vez a mano desde la pestaña **Actions** (*"Actualizar datos
   del visor" → Run workflow*) para no esperar 15 min.

## Claves de API — fuera del código fuente

**El repositorio no contiene ninguna clave de API.** El visor las pide en
tiempo de ejecución mediante los campos de la barra lateral y las usa solo
para llamar a las APIs oficiales.

Por comodidad hay una casilla **«Recordar en este navegador»** (opt-in): si
la marcas, las claves se guardan en el `localStorage` de tu navegador —nunca
en el código ni en el repositorio— para no tener que pegarlas en cada recarga;
al desmarcarla se borran. Es almacenamiento por-origen del navegador, cómodo
para uso personal. Para un despliegue serio, la vía recomendada es un backend
(GitHub Actions + *Secret*) que precompute los datos sin exponer la clave al
cliente (ver «Aviso sobre CORS»).

- **AEMET**: solicita tu clave gratuita en
  [opendata.aemet.es](https://opendata.aemet.es/centrodedescargas/inicio) (llega por email).
- **GRAFCAN**: solicítala en [sensores.grafcan.es](https://sensores.grafcan.es).

> El `.gitignore` bloquea además `.env`, `keys.js`, `secrets.*`, etc., para
> evitar que se cuele por error cualquier archivo local con secretos.

## Uso

Al ser un único archivo estático, basta con abrir `index.html` en el
navegador (o servirlo). Introduce al menos una clave y pulsa **Cargar datos**.

El panel **"JSON crudo"** de la barra lateral muestra una muestra de la
respuesta de cada endpoint (útil para depurar el mapeo de campos de GRAFCAN).

### Aviso sobre CORS

Al llamar a las APIs directamente desde el navegador puede haber
restricciones de **CORS** (especialmente GRAFCAN). Si aparece "respuesta
no-JSON (¿CORS?)", la solución recomendada es precomputar un JSON estático
con un proceso programado (p. ej. **GitHub Actions**) y que el frontend solo
lo lea — arquitectura ya prevista en los comentarios de `index.html`.

## Publicar en GitHub Pages

1. Sube el repo a GitHub.
2. *Settings → Pages → Deploy from a branch* → rama `main`, carpeta `/root`.
3. El sitio queda disponible en `https://<usuario>.github.io/<repo>/`.

## Estado

- [x] AEMET: descarga, filtrado por Gran Canaria, histórico y pintado por variable.
- [x] GRAFCAN: pipeline correcto (things + locations + observations_last), verificado con datos reales.
- [x] Mapas base (oscuro/ortofoto/topográfico/relieve), interpolación IDW+altitud,
      línea de tiempo, humedad de combustible muerto, predicción AEMET (diaria/horaria).
- [x] Backend GitHub Actions: `data/stations.json` precomputado cada 15 min.
- [ ] Radar / rayos / riesgo de incendios de AEMET (capas imagen): en standby —
      mismo patrón que el resto, pendiente de mover su descarga al backend
      también (para evitar el WAF de AEMET desde el navegador).
