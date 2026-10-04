# Device calibration

Photorefraction converts geometry into dioptres. A 1 mm error in flash eccentricity at e = 9 mm is an
11% scale error on every reading. An uncalibrated device therefore adds an SD of 0.5 D to M
(`calibration_sd_uncalibrated`). A calibrated device adds 0.2 D.

## 1. Flash geometry (required)

1. Hold the phone in portrait with the **screen facing you** and the rear camera facing away. In this
   view, x points right and y points up.
2. Use calipers to measure from the **centre of the lens in use** to the **centre of the LED emitter**.
   On a multi-camera phone, check which lens the browser opens: the app shows its label and
   resolution.
3. Enter x and y in mm in **Calibration → Add a measured device**. The eccentricity is √(x² + y²), and
   the source direction in the image follows from the angle.
4. The direction convention is verified on the bench (RESEARCH_PROTOCOL stage 0): the measured
   crescent side must match the prediction for a known myopic lens.

On some phones the torch is not the same emitter as the flash, so measure the one that lights during
capture. The app pulses the torch only during the burst (with a 250 ms settle time), because a
continuous torch constricts the pupil.

## 2. Field of view and distance

Distance comes from iris size, using a horizontal visible iris diameter (HVID) of 11.7 ± 0.45 mm:
d = f·HVID / iris_px, where f = (W/2) / tan(HFOV/2).

- **Ruler method.** Photograph a ruler of length L at distance D. Then
  HFOV = 2·atan(W / (2·f)), with f = ruler_px · D / L. Enter it in the calibration page.
- **Checkerboard.** `eyeref.calibration.camera.calibrate_intrinsics` gives the focal length and
  distortion from 15 or more checkerboard images.
- **Personal HVID.** Optical biometry white-to-white removes the ±4% population error.
- **Tape measure.** Best of all: switch to manual distance during capture. Distance error enters the
  result as 1/d.

## 3. Gradient gain (turns dead-zone intervals into values)

Inside the dead zone there is no crescent, but the brightness slope across the pupil still changes
with defocus. EyeRef models

```
P = centre − gain · slope · halfwidth,    centre = −1/d,  halfwidth = e/(d·p)
```

with the gain measured per device:

1. Use a model eye at the working distance, with the pupil set to about 6 mm.
2. Add trial lenses covering the dead zone (for example −2.5 to +0.5 D in 0.25 D steps), with 10 frames
   per step at 0° and 90°.
3. Fit with `eyeref.calibration.gradient.fit_gradient_gain(slopes, refractions, geometry)`. It returns
   the gain, intercept, residual SD, n and r.
4. Accept the calibration if r ≥ 0.9 and the residual SD is ≤ 0.35 of a half-width. Store
   `gradient_gain`, `gradient_rel_sd` and a `calibration_version` such as `bench-2026-10-xx` in the
   device profile.
5. Repeat after any change of phone model, camera module or OS camera pipeline.

On the simulator, the gain fitted this way is 5.78 (`simulated-phone`, `sim-bench-1`). That value is
**SIMULATED** and must not be used for any real phone.

## 4. Screen (vision test only)

Drag the on-screen rectangle until it matches a bank card (85.60 mm). This gives px/mm, which the
tumbling-E sizes depend on.

## 5. What is stored

Device profiles live in `backend/eyeref/calibration/device_profiles.py` (built-in), in
`$EYEREF_DATA_DIR/device_profiles/*.json` (server side) and in the browser settings (custom). Every
prediction records `device_profile` and `calibration_version`.
