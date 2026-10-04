# Regulatory roadmap (path to a medical device)

> This is a planning outline, not regulatory advice. Confirm classification with each regulator early
> (an FDA Q-Submission, or an EU notified-body consultation).

## Intended use matters most

| Candidate intended use | Likely regulatory weight |
| --- | --- |
| Research tool, data collection only (today) | Research use under ethics approval; not marketed |
| "Screening aid: flags possible refractive error for referral", used by trained staff | Medical device software; moderate risk |
| "Measures refractive error / supports prescribing" | Higher scrutiny; needs refractometer-level accuracy evidence |

Start with the **narrowest** claim: referral screening for myopia, hyperopia and anisometropia by
trained operators, with spherical equivalent only. Add claims later with new evidence.

## Likely classification (to be confirmed)

- **US (FDA).** Software that estimates refractive error is a device. The probable route is
  **510(k)**, using a photoscreener or refractometer predicate if a suitable one exists, or
  **De Novo** if none does. Open a Pre-Submission early to agree the predicate, the reference standard
  (cycloplegic refraction for children) and the study design.
- **EU (MDR 2017/745).** Software that provides information used for diagnostic or screening decisions
  falls under **Rule 11**, so at least **Class IIa**, which requires a notified body.
- **UK (MHRA, UKCA / CE transition rules)**, **India (CDSCO, MDR 2017)** and others follow similar
  risk-based approaches.

## What has to exist

1. **Quality management system:** ISO 13485, with design controls (21 CFR 820 / QMSR).
2. **Software life cycle:** IEC 62304, with an expected safety class of B. This covers:
   - requirements, architecture and unit and integration testing;
   - SOUP management, which here means MediaPipe, ONNX Runtime, Next.js and the browser;
   - a locked model version.
3. **Risk management (ISO 14971).** Key hazards:
   - a missed high myopia or anisometropia, leading to amblyopia risk in children;
   - a false reassurance about disease, from the red reflex;
   - a mis-assigned eye (OD/OS swap);
   - an axis error from mirroring;
   - light exposure.

   The gating, the reflex-asymmetry flag, the geometric OD/OS assignment and the torch pulses in this
   repo are risk controls. They need traceable verification.
4. **Usability (IEC 62366-1):** formative and summative studies with the intended operators.
5. **Clinical evaluation and investigation (ISO 14155).**
   - Do a prospective multi-site study against **cycloplegic refraction** for children and subjective
     refraction for adults.
   - Pre-specify primary endpoints, such as sensitivity and specificity for referral-worthy refractive
     error with a lower 95% CI bound above target, and SE limits of agreement.
   - Report under STARD.
6. **AI/ML specifics.**
   - Keep a frozen model, with the data lineage documented (which the sidecar metadata starts).
   - Test generalisation by subgroup and by device.
   - Use a **predetermined change control plan (PCCP)** for future model updates.
   - Monitor performance after release.
7. **Device scope.** Each supported phone model needs bench calibration and its own verification. A
   "works on any phone" claim is not supportable.
8. **Cybersecurity and privacy:**
   - threat model, SBOM and secure update (FDA premarket cybersecurity guidance);
   - GDPR and HIPAA as applicable;
   - data minimisation (already designed in).
9. **Photobiological safety:** IEC 62471 for the torch, the flash and any NIR module.

## Suggested sequence

| Step | Output |
| --- | --- |
| 1 | Bench verification and RESEARCH_PROTOCOL stages 0–2 under ethics approval |
| 2 | Freeze the intended use; regulatory strategy memo; Pre-Submission |
| 3 | Stand up the QMS; move this codebase under IEC 62304 (native app as the product) |
| 4 | Pivotal clinical study on the locked version |
| 5 | Submission; post-market surveillance plan |
