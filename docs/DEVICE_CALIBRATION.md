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

## 3. Bench run: the geometry check and the gradient gain

Inside the dead zone there is no crescent, but the brightness slope across the pupil still changes
with defocus. EyeRef models

```
P = centre − gain · slope · halfwidth,    centre = −1/d,  halfwidth = e/(d·p)
```

with the gain measured per device. The app measures it on the bench, in the same run that checks the
phone against the photorefraction model (stage 0 of docs/RESEARCH_PROTOCOL.md): **Calibration → Open
the bench**.

1. Add the phone's measured flash position first (section 1). The run checks that measurement before
   it measures anything, and it calibrates only a measured device.
2. Mount the phone at a measured distance from a model eye (1 m), with the model eye's pupil set to
   about 6 mm, in a dim room. Enter the distance, the pupil, the model eye's own refraction (0 if it
   is emmetropic) and the lens-to-eye distance. The page shows the dead zone the model predicts.
3. Choose the lenses: −4 to +4 D in 0.5 D steps (stage 0), or the same with 0.25 D steps across the
   predicted dead zone, which gives the gain more levels to fit. Every lens is captured with the phone
   at 0°, then again at 90°: a quarter turn anticlockwise as you look at the screen, with the screen
   turning to landscape.
4. For each step, put the lens in, centre the circle on the model eye's pupil (the magnified view
   helps; a tap moves the circle) and capture. A step is a burst with the light pulsed as in an
   assessment. A step without usable frames can be captured again. The run is kept in the browser as
   it goes, so a reload offers to continue it. It keeps measurements only, never an image.
5. The report gives go or no go:

   | Check | Passes when |
   | --- | --- |
   | Every step captured | Every step has at least one usable frame (a pupil, and quality acceptable or better). |
   | Crescent on the predicted side | At every step more than 0.25 D outside the predicted dead zone, on both sides of it, most usable frames show a crescent on the side the model predicts. A whole rotation on the wrong side is named: at every rotation it points at the flash position's sign, at one rotation at how the browser turns the frames. |
   | Crescent width matches the model | Inverted with the profile's geometry, the crescent width follows the refraction the lens gives with a slope of 0.8 to 1.2, over 3 or more steps clear of the dead zone. Saturated crescents (over 92% of the pupil) are left out. The slope is the ratio of the true eccentricity, or distance, to the one entered. |
   | Dead zone where predicted | The crescent disappears, half-way between steps, within 0.25 D of both predicted edges. |
   | Repeated frames agree | ICC(1,1) of the estimator's values from repeated frames is 0.9 or more. |
   | Gradient gain fits | Inside the predicted dead zone, the fit `(refraction − centre)/halfwidth = −gain·slope + b` (`eyeref.calibration.gradient.fit_gradient_gain`, Huber-weighted) has a positive gain, \|r\| ≥ 0.9 and a residual SD ≤ 0.35 of a half-width, from 3 or more refractions. |

6. On go, **Save** writes `gradientGain`, `gradientRelSd` (the residual SD) and a
   `calibrationVersion` of `bench-YYYY-MM-DD` into the device profile. From then on, a frame from that
   phone without a crescent gives a value with its own interval, not just the dead zone.
7. **Download the run** for the record. The file holds every frame's measurements, in the backend's
   field names, and no image. `python -m eyeref.research.bench_run run.json` gives the same report from
   it (with `--json` for the whole report), and exits with 0 on go and 1 on no go.
8. Repeat after any change of phone model, camera module or OS camera pipeline.

In Simulation Mode the page renders the model eye and runs every frame through the same extractor and
checks. A simulated run's gain is never saved to a device. Its **Simulated mistake** option shows which
checks catch a flash measured on the wrong side of the lens, or a model eye nearer than the distance
entered.

The simulated phone's profile has a gain of 5.78 (`simulated-phone`, `sim-bench-1`), fitted by
`eyeref.simulation.bench.calibrate_gradient_on_simulation` to varied pupils, fundus reflectance and
source angles. A simulated bench run measures about 6.1 on one model eye, within 10% of it. Both are
**SIMULATED** and must not be used for any real phone.

## 4. Screen (vision test only)

Drag the on-screen rectangle until it matches a bank card (85.60 mm). This gives px/mm, which the
tumbling-E sizes depend on.

## 5. What is stored

Device profiles live in `backend/eyeref/calibration/device_profiles.py` (built-in), in
`$EYEREF_DATA_DIR/device_profiles/*.json` (server side) and in the browser settings (custom). Every
prediction records `device_profile` and `calibration_version`.
