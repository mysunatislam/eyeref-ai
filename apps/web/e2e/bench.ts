import type { Page } from "@playwright/test";

/** A phone whose flash position was measured, as the calibration page saves one. */
export const PHONE = {
  id: "custom-bench-phone",
  manufacturer: "custom",
  model: "Bench phone",
  camera: "rear",
  hfovDeg: 68,
  flashOffsetMm: [0, -9.4],
  apertureDiameterMm: 2.8,
  gradientGain: null,
  gradientRelSd: 0.35,
  calibrationVersion: "manual-2026-01-01",
  notes:
    "Flash offset measured with a ruler. Gradient gain not calibrated (dead-zone readings stay intervals).",
};

/** Leaves Simulation Mode, with or without a measured phone among the custom devices. */
export async function leaveSimulation(page: Page, withPhone: boolean) {
  await page.goto("/calibration");
  await page.evaluate(
    ({ phone, withPhone }) =>
      localStorage.setItem(
        "eyeref.settings.v1",
        JSON.stringify({
          simulationMode: false,
          customDevices: withPhone ? [phone] : [],
          deviceId: withPhone ? phone.id : "generic-phone-rear",
        }),
      ),
    { phone: PHONE, withPhone },
  );
}
