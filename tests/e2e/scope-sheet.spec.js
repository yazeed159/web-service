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
