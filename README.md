# SONIC FORGE 404

**Estudio musical local-first · RC v0.22.0**

Secuenciador y compositor musical en el navegador, con exportación WAV y módulos opcionales para generación con ACE-Step y separación de stems con Demucs. La interfaz funciona sin cuenta, telemetría ni dependencias externas. Los modelos de IA no están incluidos.

> **Estado:** release candidate. La aplicación web y el diagnóstico se han probado en este entorno; falta validar la experiencia de audio y los scripts `.bat` en Windows real, además de generación y separación con modelos/GPU reales.

## Qué incluye

- Secuenciador Web Audio de seis canales, mezclador, efectos, arreglos y exportación WAV.
- Clips de audio importados con controles de edición y herramientas de sincronización/afinación.
- Exportación de stems de sintetizador y mezcla master.
- Recuperación local de sesión. Los archivos de audio importados no se guardan en el proyecto JSON ni en la copia de recuperación.
- Generación opcional mediante un puente Python local hacia ACE-Step.
- Separación opcional de audio WAV mediante Demucs.
- Diagnóstico de Windows que genera informes JSON y TXT sin instalar ni modificar componentes.

## Inicio rápido

### Solo estudio web

Abre `index.html` en un navegador moderno o publica el repositorio con GitHub Pages. El secuenciador, la importación de audio y la exportación local funcionan en el navegador. GitHub Pages **no ejecuta Python, ACE-Step ni Demucs**; las funciones que requieren el puente local aparecerán desconectadas.

### Puente local en Windows

1. Instala Python 3.11 o 3.12 y descomprime el proyecto.
2. Para generar música, instala ACE-Step 1.5 desde su [repositorio oficial](https://github.com/ACE-Step/ACE-Step-1.5) y arranca su API en `http://127.0.0.1:8001`.
3. Ejecuta `INICIAR-SONIC.bat`. El puente escucha únicamente en `127.0.0.1:8765`.
4. Abre `http://127.0.0.1:8765` y comprueba el estado desde la interfaz.

No se instalan modelos automáticamente. Pueden requerir varios GB y una GPU compatible; la ejecución en CPU puede ser muy lenta. Si ACE-Step usa una clave API, define `ACESTEP_API_KEY` en el entorno antes de iniciar el puente. No publiques claves ni informes locales.

### Separación de stems

Instala Python, FFmpeg y una versión de PyTorch compatible con tu hardware; después ejecuta `INSTALAR-DEMUCS.bat`. Inicia el puente, importa un WAV de hasta 80 MB y ejecuta la separación. Demucs descarga sus pesos en su primer uso y puede tardar bastante en CPU. Revisa las licencias de los modelos antes de uso comercial.

### Diagnóstico Windows

Ejecuta `DIAGNOSTICAR-WINDOWS.bat`. Los informes aparecen en `diagnostico/`. El diagnóstico detecta herramientas, paquetes y disponibilidad de servicios; **no** confirma que los modelos generen audio correctamente. Los informes pueden revelar nombres de dispositivos y rutas locales, así que revísalos antes de compartirlos.

## Pruebas

Desde la carpeta del proyecto:

```bash
python -m unittest -v test_diagnostics_phase22.py test_release.py test_publication_phase21.py test_integration_phase17.py
```

Las pruebas de navegador necesitan instalar `requirements-dev.txt` y Chromium de Playwright:

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
python test_browser.py
python test_audio_phase18.py
python test_performance_phase19.py
python test_recovery_phase20.py
```

Las pruebas de servidor abren puertos locales y pueden estar bloqueadas en entornos de ejecución restringidos. Las pruebas de navegador usan audio simulado y no sustituyen una escucha humana, una prueba en Windows ni una inferencia real.

## Publicación en GitHub

1. Crea un repositorio público y sube el contenido de esta carpeta en la raíz.
2. Activa **Settings → Pages → Deploy from a branch → `main` → `/ (root)`**.
3. GitHub Pages publica el estudio web. Para usar ACE-Step o Demucs, descarga y ejecuta el proyecto localmente con sus dependencias.

No incluyas claves, audio privado, informes de diagnóstico ni la carpeta `.sonic-stem-jobs/`. `.gitignore` excluye esos datos locales. El repositorio no incorpora los modelos de IA.

## Privacidad y límites

- El puente Python enlaza a loopback y publica solo los activos web permitidos; no lo expongas directamente a Internet.
- Los prompts se envían al servidor ACE-Step local configurado; el puente no añade telemetría.
- Las tareas IA y la separación necesitan sus servicios locales, que son proyectos y dependencias separados.
- El JSON de proyecto almacena ajustes y nombres, no los bytes de audio importados.
- El estiramiento temporal y la detección de BPM son herramientas experimentales; pueden producir artefactos o estimaciones incorrectas.
- La exportación de audio y la medición de pico/RMS no certifican loudness comercial ni true peak.

## Estructura

| Archivo | Función |
|---|---|
| `index.html`, `styles.css` | Interfaz del estudio |
| `app.js` | Secuenciador, mezclador y render WAV |
| `ai.js`, `stems.js`, `recovery.js` | Generación, separación y recuperación local |
| `ai_bridge.py` | Servidor local para activos web y APIs IA |
| `diagnostico_windows.py` | Diagnóstico de solo lectura |
| `test_*.py` | Pruebas automatizadas y simulaciones |

Consulta `QA_PUBLICACION.md` para el resultado de auditoría de esta entrega y `QA_FASE_*.md` para el historial de fases.
