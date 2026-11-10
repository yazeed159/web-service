// tests/e2e/scope-sheet.spec.js
//
// The "View" sheet (js/accounts/accounts.js): the topbar pill opens a slide-over where you pick an
// account and then a period from a timeline -- no dropdown, no Apply button -- and the dashboard only
// carries a slim balance line (the per-period list lives in the sheet now).
const { test, expect } = require("../helpers/fixtures");
const { trade } = require("../helpers/trades");

const A1 = "acc-main", A2 = "acc-swing";
const entry = (id, account_id, date, amount, extra = {}) => ({ _id: id, account_id, date, amount, ...extra });
const ledger = [
  entry("p1", A1, "2026-01-05", 5000),
  entry("p2", A1, "2026-06-01", 3000, { period_name: "Summer restart" }),
  entry("s1", A2, "2026-02-01", 2000),
];

test.use({
  seed: {
    trades: [
      trade({ account_id: A1, trade_date: "2026-02-10", pnl_after_comm: 300 }),
      trade({ account_id: A1, trade_date: "2026-07-10", pnl_after_comm: -120 }),
      trade({ account_id: A2, trade_date: "2026-03-10", pnl_after_comm: 80 }),
    ],
    kv: [{ user_id: "u1", key: "capital_ledger", value: ledger }],
  },
});

test.beforeEach(async ({ page }) => {
  // The fake Supabase has no `accounts` table by default; slip two rows in as it creates its db.
  await page.addInitScript(({ A1, A2 }) => {
    let db;
    Object.defineProperty(window, "__db", {
      configurable: true,
      get: () => db,
      set: (v) => {
        db = v;
        db.accounts = [
          { id: A1, name: "Main", kind: "live", color: "#8b7cf6", status: "active", user_id: "u1" },
          { id: A2, name: "Swing", kind: "live", color: "#22d3ee", status: "active", user_id: "u1" },
        ];
      },
    });
  }, { A1, A2 });
});

test("pill opens a sheet with account cards; Escape closes it", async ({ page }) => {
  await page.goto("/index.html");
  await page.locator("#scope-switch").click();
  const sheet = page.locator(".sv-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".sv-card")).toHaveCount(3); // All real accounts + Main + Swing
  await expect(sheet.locator("select")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("pick an account, then a period from the timeline", async ({ page }) => {
  await page.goto("/index.html");
  await page.locator("#scope-switch").click();
  await page.locator('.sv-card[data-acc="' + A1 + '"]').click();
  // Entire account + the two periods
  await expect(page.locator(".sv-row")).toHaveCount(3);
  await page.locator('.sv-row:has-text("Summer restart")').click();
  await page.waitForLoadState("load");
  await expect(page.locator("#scope-switch .scope-label")).toHaveText(/Main · Summer restart/);
  const scope = await page.evaluate(() => JSON.parse(localStorage.getItem("scope:v1")));
  expect(scope.ids).toEqual([A1]);
  expect(scope.period).toBe("p2");
});

test("dashboard shows a slim balance line, not the per-period list", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator("#dash-balance .bal-slim")).toBeVisible();
  await expect(page.locator(".bal-period, .bal-periods")).toHaveCount(0);
  const h = await page.locator("#dash-balance .bal-slim").evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeLessThan(80);
  // The scope button on the line opens the same sheet.
  await page.locator("#dash-balance [data-open-scope]").click();
  await expect(page.locator(".sv-sheet")).toBeVisible();
});

test("All real accounts applies in one tap", async ({ page }) => {
  await page.goto("/index.html");
  await page.locator("#scope-switch").click();
  await page.locator('.sv-card[data-acc="' + A2 + '"]').click(); // no periods beyond one -> applies now
  await page.waitForLoadState("load");
  await expect(page.locator("#scope-switch .scope-label")).toHaveText("Swing");
  await page.locator("#scope-switch").click();
  await page.locator(".sv-card[data-all]").click();
  await page.waitForLoadState("load");
  await expect(page.locator("#scope-switch .scope-label")).toHaveText("All real accounts");
});

test("a custom date range limits every page and shows in the pill and hero", async ({ page }) => {
  await page.goto("/index.html");
  await page.locator("#scope-switch").click();
  await page.locator("[data-range-custom]").click();
  await page.locator("#sv-from").fill("2026-02-01");
  await page.locator("#sv-to").fill("2026-03-31");
  await page.locator("[data-range-apply]").click();
  await page.waitForLoadState("load");
  await expect(page.locator("#scope-switch .scope-label")).toContainText("Feb 1, 2026 \u2013 Mar 31, 2026");
  // Main +300 (Feb) and Swing +80 (Mar) are inside; Main -120 (Jul) is not.
  await expect(page.locator(".hero-value")).toHaveText("+$380.00");
  const scope = await page.evaluate(() => JSON.parse(localStorage.getItem("scope:v1")));
  expect(scope.range).toEqual({ from: "2026-02-01", to: "2026-03-31" });
  // Picking an account keeps the dates; "All time" clears them.
  await page.locator("#scope-switch").click();
  await page.locator('.sv-card[data-acc="' + A2 + '"]').click();
  await page.waitForLoadState("load");
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("scope:v1")))).range).toBeTruthy();
  await page.locator("#scope-switch").click();
  await page.locator('[data-range=""]').click();
  await page.waitForLoadState("load");
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("scope:v1")))).range).toBeUndefined();
});

test("a preset like This year resolves against today and V opens the sheet", async ({ page }) => {
  await page.goto("/index.html");
  await page.locator("#scope-switch").waitFor(); // the V key is wired when the pill mounts
  await page.keyboard.press("v");
  await expect(page.locator(".sv-sheet")).toBeVisible();
  await page.locator('[data-range="ytd"]').click();
  await page.waitForLoadState("load");
  await expect(page.locator("#scope-switch .scope-label")).toContainText("This year");
  await expect(page.locator(".hero-label")).toContainText("this year");
});

test("Customize: hide and reorder dashboard sections, remembered after reload", async ({ page }) => {
  await page.goto("/index.html");
  await page.locator("#dash-customize").click();
  await expect(page.locator(".sv-sheet")).toBeVisible();
  await page.locator('[data-toggle="recent"]').click();
  await expect(page.locator('[data-dash-unit="recent"]')).toBeHidden();
  await page.locator('[data-move="equity"][data-dir="-1"]').click(); // equity above the Form guide / calendar row
  await page.keyboard.press("Escape");
  await expect(page.locator(".dash-hidden-note")).toContainText("1 section is hidden");
  await page.reload();
  await expect(page.locator('[data-dash-unit="recent"]')).toBeHidden();
  const orders = await page.evaluate(() => ["equity", "pair"].map((u) => Number(document.querySelector('[data-dash-unit="' + u + '"]').style.order)));
  expect(orders[0]).toBeLessThan(orders[1]);
  // Calm preset hides the two cards and recent trades; hiding only one card gives the other the full row.
  await page.locator("#dash-customize").click();
  await page.locator('[data-preset="calm"]').click();
  await expect(page.locator('[data-dash-unit="pair"]')).toBeHidden();
  await page.locator('[data-preset="all"]').click();
  await page.locator('[data-toggle="month"]').click();
  await expect(page.locator('[data-dash-unit="pair"]')).toHaveClass(/dash-one/);
});
