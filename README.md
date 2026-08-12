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

- [x] AEMET: descarga, filtrado por Gran Canaria y pintado por variable.
- [x] GRAFCAN: pipeline correcto (things + locations + datastreams + observations_last).
- [ ] GRAFCAN: confirmar nombres exactos de datastreams/observedProperty y la
      unidad del viento con el JSON real (panel de depuración) — ver `VAR_MATCHERS`.
