// tests/journal-table.spec.js
//
// Renders journal.html against the in-memory fake Supabase (tests/helpers) with
// known trades and checks what's actually on screen: the table, the Tags cell's
// layout, every filter, sorting and paging. The unit tests cover the helpers;
// these catch the regressions that only show up once real markup meets real CSS
// (e.g. a Tags cell that grows the row instead of tucking pills behind "+N").
const { test, expect } = require("./helpers/fixtures");
const { trade } = require("./helpers/trades");

const rows = (page) => page.locator("#journal-tbody tr[data-id]");

// The filter panel starts folded (a floating card that closes on outside click / Esc),
// and selects are swapped for custom dropdowns -- so drive them the way a person does.
async function openFilters(page) {
  const toggle = page.locator("#filters-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.locator("#journal-filters")).toBeVisible();
}
async function pick(page, id, value) {
  await openFilters(page);
  const index = await page.locator(`#${id} option`).evaluateAll((o, v) => o.findIndex((x) => x.value === v), value);
  expect(index, `#${id} has an option "${value}"`).toBeGreaterThanOrEqual(0);
  await page.locator(`.ds:has(#${id}) .ds-trigger`).click();
  await page.locator(".ds-menu .ds-opt").nth(index).click();
  await expect(page.locator(`#${id}`)).toHaveValue(value);
}
async function type(page, id, value) { await openFilters(page); await page.fill(`#${id}`, value); }

const TRADES = [
  trade({ id: "A1", symbol: "ABCD", trade_date: "2026-09-18", entry_time: "09:35:00", pnl_after_comm: 38, setup_type: "breakout", behavior_tags: [] }),
  trade({ id: "A2", symbol: "WXYZ", trade_date: "2026-09-18", entry_time: "10:05:00", pnl_after_comm: -22, setup_type: "dip_buy", behavior_tags: ["price_chased"], lesson_tags: ["fomo"] }),
  trade({ id: "A3", symbol: "QQQQ", trade_date: "2026-09-21", entry_time: "09:40:00", pnl_after_comm: 9, side: "short", setup_type: "breakout",
    behavior_tags: ["price_extended", "rvol_5x_10x", "float_micro_under_10m"], lesson_tags: ["patient", "sized_well"] }),
  trade({ id: "A4", symbol: "ZZZZ", trade_date: "2026-09-22", entry_time: "14:10:00", pnl_after_comm: -5, better_exit_price: 6.1 }),
];

test.describe("journal table", () => {
  test.use({ seed: { trades: TRADES } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/journal.html");
    await expect(rows(page)).toHaveCount(TRADES.length);
  });

  test("renders one row per trade with symbol, date and signed P&L, newest first", async ({ page, pageErrors }) => {
    await expect(rows(page).first()).toContainText("ZZZZ");
    await expect(rows(page).last()).toContainText("ABCD");
    const a2 = page.locator('tr[data-id="A2"]');
    await expect(a2).toContainText("WXYZ");
    await expect(a2).toContainText("2026-09-18");
    await expect(a2).toContainText(/-\$?22/);
    expect(pageErrors).toEqual([]);
  });

  test("Tags cell stays one line: two pills inline, the rest behind a +N chip", async ({ page }) => {
    const cell = (id) => page.locator(`tr[data-id="${id}"] .tags-cell`);
    // A3 has 5 tags -> 2 visible pills + "+3".
    const a3 = cell("A3");
    await expect(a3.locator(".tags-cell-pills .pill:visible")).toHaveCount(2);
    await expect(a3.locator(".tags-more")).toHaveText("+3");
    // A tag-less row shows the dash placeholder and no chip.
    await expect(cell("A1").locator(".tags-more")).toHaveCount(0);
    await expect(cell("A1")).toContainText("—");

    // Layout regression guard: a 5-tag row must be no taller than a 0-tag row,
    // and its pills must not spill outside the cell.
    const h = async (id) => (await page.locator(`tr[data-id="${id}"]`).boundingBox()).height;
    expect(Math.abs((await h("A3")) - (await h("A1")))).toBeLessThanOrEqual(2);
    const td = await page.locator('tr[data-id="A3"] td.col-tags').boundingBox();
    const pills = await a3.locator(".tags-cell-pills").boundingBox();
    expect(pills.x + pills.width).toBeLessThanOrEqual(td.x + td.width + 1);
  });

  test("the +N chip opens every tag in a floating card without growing the row, and closes again", async ({ page }) => {
    const row = page.locator('tr[data-id="A3"]');
    const before = (await row.boundingBox()).height;
    const chip = row.locator(".tags-more");
    await chip.click();
    await expect(row.locator(".tags-cell")).toHaveClass(/open/);
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator(".tags-cell-pills .pill:visible")).toHaveCount(5);
    expect(Math.abs((await row.boundingBox()).height - before)).toBeLessThanOrEqual(1);
    await chip.click();
    await expect(row.locator(".tags-cell")).not.toHaveClass(/open/);
    await expect(row.locator(".tags-cell-pills .pill:visible")).toHaveCount(2);
    await expect(chip).toHaveText("+3");
  });

  test("tags dropdown lists behaviour and lesson tags; picking one filters rows", async ({ page }) => {
    await openFilters(page);
    const opts = await page.locator("#f-tag option").evaluateAll((o) => o.map((x) => x.value));
    expect(opts).toEqual(expect.arrayContaining(["price_chased", "fomo", "patient", "price_extended"]));
    await pick(page, "f-tag", "fomo");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("WXYZ");
  });

  test("symbol filter is case-insensitive and partial", async ({ page }) => {
    await type(page, "f-symbol", "qq");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("QQQQ");
  });

  test("win/loss filter", async ({ page }) => {
    await pick(page, "f-result", "win");
    await expect(rows(page)).toHaveCount(2);
    await pick(page, "f-result", "loss");
    await expect(rows(page)).toHaveCount(2);
    for (const t of await rows(page).allInnerTexts()) expect(t).toMatch(/WXYZ|ZZZZ/);
  });

  test("setup filter", async ({ page }) => {
    await pick(page, "f-setup", "breakout");
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator("#journal-tbody")).not.toContainText("WXYZ");
  });

  test("date range filter is inclusive on both ends", async ({ page }) => {
    await type(page, "f-from", "2026-09-21");
    await type(page, "f-to", "2026-09-21");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("QQQQ");
  });

  test("entry-time range filter", async ({ page }) => {
    await type(page, "f-time-from", "10:00");
    await expect(rows(page)).toHaveCount(2); // WXYZ 10:05, ZZZZ 14:10
    await type(page, "f-time-to", "11:00");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("WXYZ");
  });

  test("'better entry/exit flagged' filter", async ({ page }) => {
    await openFilters(page);
    await page.check("#f-flagged");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("ZZZZ");
  });

  test("filters combine, and the empty state's Clear button restores every row", async ({ page }) => {
    await pick(page, "f-result", "win");
    await type(page, "f-symbol", "WXYZ"); // a loss -> nothing matches both
    await expect(rows(page)).toHaveCount(0);
    // The open filter card floats over the empty state's button; fold it like a user would.
    await page.keyboard.press("Escape");
    await page.locator("#empty-clear-filters").click();
    await expect(rows(page)).toHaveCount(TRADES.length);
    await expect(page.locator("#f-symbol")).toHaveValue("");
    await expect(page.locator("#f-result")).toHaveValue("");
  });

  test("Filters button shows how many filters are active, and Esc folds the panel", async ({ page }) => {
    await expect(page.locator("#journal-filters")).toBeHidden();
    await pick(page, "f-result", "win");
    await openFilters(page);
    await expect(page.locator("#filters-toggle-count")).toHaveText("1");
    await page.keyboard.press("Escape");
    await expect(page.locator("#journal-filters")).toBeHidden();
    await expect(page.locator("#filters-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  test("clicking a column header sorts, and clicking again reverses", async ({ page }) => {
    await page.locator('.headcell[data-sort="symbol"]').click(); // first click: desc
    await expect(rows(page).first()).toContainText("ZZZZ");
    await page.locator('.headcell[data-sort="symbol"]').click(); // second: asc
    await expect(rows(page).first()).toContainText("ABCD");
  });

  test("filter state is mirrored into the URL so Back restores the view", async ({ page }) => {
    await pick(page, "f-result", "loss");
    await type(page, "f-symbol", "ZZ");
    await expect(page).toHaveURL(/symbol=ZZ/);
    await expect(page).toHaveURL(/result=loss/);
  });

  test("clicking a row opens that trade", async ({ page }) => {
    await page.locator('tr[data-id="A2"] td').nth(1).click();
    await expect(page).toHaveURL(/trade\.html\?id=A2/);
  });
});

test.describe("journal paging", () => {
  const MANY = Array.from({ length: 60 }, (_, i) =>
    trade({ id: "P" + i, symbol: "S" + String(i).padStart(2, "0"), trade_date: "2026-08-" + String((i % 28) + 1).padStart(2, "0") }));
  test.use({ seed: { trades: MANY } });

  test("shows 50 rows then 'Load more' reveals the rest", async ({ page }) => {
    await page.goto("/journal.html");
    await expect(rows(page)).toHaveCount(50);
    const more = page.locator("#table-load-more-btn");
    await expect(more).toContainText("10 left");
    await more.click();
    await expect(rows(page)).toHaveCount(60);
    await expect(more).toHaveCount(0);
  });
});

test.describe("journal with no trades", () => {
  test.use({ seed: { trades: [] } });
  test("shows an empty state instead of a table", async ({ page, pageErrors }) => {
    await page.goto("/journal.html");
    await expect(page.locator("#journal-content .loading-line")).toHaveCount(0);
    await expect(page.locator("#journal-table")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
