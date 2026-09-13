// tests/sidebar-nav.spec.js
//
// Regression coverage for js/page-transition.js's SPA router and the
// two bugs it already caused once each: the persistent sidebar (which
// swapContent() deliberately never touches) getting out of sync with
// whichever page is actually on screen, because some page-specific bit
// of it was hand-written into the raw HTML instead of computed at
// render time. See the "Known page-specific regions of the persistent
// shell" comment at the top of page-transition.js -- these tests exist
// so the next region like that gets caught here instead of by a user
// screenshotting a stuck highlight.
//
// See tests/README.md before running these -- in particular, whether
// your pages need a logged-in session.
const { test, expect } = require("@playwright/test");

test.describe("sidebar stays in sync across SPA navigations", () => {
  test("index.html Reports tab -> Journal: highlight and status label both update", async ({ page }) => {
    await page.goto("/index.html");

    // Put the persistent sidebar into the state that caused the bug:
    // a non-default tab active on index.html (hash change, not a page
    // navigation, so page-transition.js never even sees this click).
    await page.locator('.nav-item[data-tab="reports"]').click();
    await expect(page.locator('.nav-item[data-tab="reports"]')).toHaveClass(/active/);

    // Now leave index.html via the SPA router (journal.html is in
    // SPA_PAGES) -- this is the transition that used to leave the
    // stale "Reports" state behind in both regions of the sidebar.
    await page.locator('.sidebar a[href="journal.html"]').click();
    await expect(page).toHaveURL(/journal\.html$/);

    // Region 1: the main nav section (swapSidebarMain).
    const journalLink = page.locator('#sidebar-main-section a[href="journal.html"]');
    await expect(journalLink).toHaveClass(/active/);
    const reportsLink = page.locator('#sidebar-main-section a[href="index.html#reports"]');
    await expect(reportsLink).not.toHaveClass(/active/);

    // Region 2: the pipeline-status label (swapSidebarBottom). This is
    // the exact element that showed "Scanner" while on journal.html in
    // the original bug report.
    await expect(page.locator(".pipeline-status")).toContainText("Journal");
  });

  test("journal.html -> index.html: hand-written tab buttons come back and bind correctly", async ({ page }) => {
    await page.goto("/journal.html");
    await page.locator('.sidebar a[href="index.html"]').click();
    await expect(page).toHaveURL(/index\.html$|\/$/);

    // index.html's Dashboard/Day View/Reports are real <button
    // data-tab> elements (not templated), which only exist correctly
    // if swapSidebarMain() restored index.html's own raw markup rather
    // than leaving journal.html's #sidebar-main-section mount in
    // place. Confirm app.js's click binding actually works against the
    // restored elements, not just that they're present.
    const dayView = page.locator('.nav-item[data-tab="dayview"]');
    await expect(dayView).toBeVisible();
    await dayView.click();
    await expect(dayView).toHaveClass(/active/);
    await expect(page.locator('.nav-item[data-tab="dashboard"]')).not.toHaveClass(/active/);

    await expect(page.locator(".pipeline-status")).toContainText(/Loading…|Through |No data|No trades yet/);
  });

  test("browser back/forward through an SPA transition keeps the sidebar correct", async ({ page }) => {
    await page.goto("/index.html");
    await page.locator('.sidebar a[href="journal.html"]').click();
    await expect(page).toHaveURL(/journal\.html$/);

    await page.goBack();
    await expect(page).toHaveURL(/index\.html$|\/$/);
    await expect(page.locator(".pipeline-status")).toContainText(/Loading…|Through |No data|No trades yet/);

    await page.goForward();
    await expect(page).toHaveURL(/journal\.html$/);
    await expect(page.locator('#sidebar-main-section a[href="journal.html"]')).toHaveClass(/active/);
    await expect(page.locator(".pipeline-status")).toContainText("Journal");
  });

  test("settings.html -> patterns.html: main nav highlight moves, no leftover active item", async ({ page }) => {
    await page.goto("/settings.html");
    await page.locator('.sidebar a[href="patterns.html"]').click();
    await expect(page).toHaveURL(/patterns\.html$/);

    // Exactly one item in each generated section should be active --
    // catches a future region-boundary bug where the wrong node range
    // gets replaced (see swapSidebarMain's node-walk in
    // page-transition.js) and either nothing or more than one item
    // ends up marked active.
    await expect(page.locator("#sidebar-main-section .nav-item.active")).toHaveCount(1);
    await expect(page.locator("#sidebar-more-section .nav-item.active")).toHaveCount(1);
    await expect(page.locator("#sidebar-more-section .nav-item.active")).toHaveAttribute("href", "patterns.html");
    await expect(page.locator(".pipeline-status")).toContainText("Patterns");
  });
});
