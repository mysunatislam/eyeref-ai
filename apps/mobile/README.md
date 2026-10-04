# EyeRef native app (FUTURE WORK)

The web app proves out the pipeline, but browsers limit photorefraction in four ways:

| Limitation in the browser | Native capability needed |
| --- | --- |
| Video stream ≈ 1080p, compressed: a 6 mm pupil spans about 9–17 px at 1 m | Full-resolution **RAW/DNG stills** (12–50 MP) with telephoto/optical zoom: 60–150 px per pupil |
| Auto exposure, focus and white balance change between frames | **Locked** focus distance, exposure, ISO and white balance per burst |
| Torch only, with ≈ 100–300 ms latency, and no torch control on iOS Safari | Flash **synchronised** to the exposure; short pulses (no pupil constriction) |
| Device rotation from DeviceMotion permissions | Native sensors at capture time, written into the EXIF/metadata |

## Plan

- **Stack.** Kotlin with CameraX / Camera2 on Android first, since it gives reliable torch and RAW.
  Swift with AVFoundation on iOS next.
- **Reuse.** Port the TypeScript `lib/` (optics, CV, quality, fusion) to a shared Kotlin Multiplatform
  module, or run it in an embedded JS engine. The golden-test fixtures in `shared/fixtures` must give
  identical outputs.
- **Face tracking.** MediaPipe Face Landmarker (Android AAR / iOS framework) for the guide UI only.
- **Per-model calibration.** Each phone model ships a measured profile: flash offset, lens and torch
  pair, HFOV and gradient gain.
- **Safety.** IEC 62471 assessment of the flash and torch pulse duty cycle.
