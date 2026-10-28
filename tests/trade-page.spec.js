// tests/trade-page.spec.js -- the trade detail page renders and its journal card works.
// (Regression: a missing `chip` helper threw "chip is not defined" and the whole page
// showed "Couldn't load this trade".)
const { test, expect } = require("./helpers/fixtures");
const { trade } = require("./helpers/trades");

test.use({ seed: { trades: [trade({ id: "T1", symbol: "ABCD", behavior_tags: ["price_chased"] })] } });

test("trade page loads with no errors and shows the journal card", async ({ page, pageErrors }) => {
  await page.goto("/trade.html?id=T1");
  await expect(page.locator("#jn-stop")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Couldn't load this trade");
  await expect(page.locator(".th-symbol")).toHaveText("ABCD");
  expect(pageErrors).toEqual([]);
});

test("planned stop/target 'None' toggles lock the field and survive a reload", async ({ page }) => {
  await page.goto("/trade.html?id=T1");
  await page.fill("#jn-stop", "4.80");
  const none = page.locator('[data-none-for="stop"]');
  await expect(none).toHaveAttribute("aria-pressed", "false");
  await none.click();
  await expect(page.locator("#jn-stop")).toBeDisabled();
  await expect(page.locator("#jn-stop")).toHaveValue("");
  await expect(page.locator('[data-none-for="stop"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#jn-metrics")).toContainText("No planned stop");
  await page.reload();
  await expect(page.locator("#jn-stop")).toBeDisabled();
  await page.locator('[data-none-for="stop"]').click();
  await expect(page.locator("#jn-stop")).toBeEnabled();
});
