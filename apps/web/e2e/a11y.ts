import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Colour-scheme changes animate (the buttons transition background and colour), so a scan can
 * otherwise catch a half-blended colour and report a contrast violation that no one ever sees.
 */
async function settleMotion(page: Page) {
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  });
  await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
}

/** WCAG 2.1 A/AA violations that axe rates serious or critical, one line each. */
export async function seriousViolations(page: Page): Promise<string[]> {
  await settleMotion(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => {
      const worst = v.nodes[0];
      const data = worst?.any?.[0]?.data as { contrastRatio?: number } | undefined;
      const ratio = data?.contrastRatio ? ` ratio ${data.contrastRatio}` : "";
      return `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${worst?.target.join(" ")}${ratio}`;
    });
}
