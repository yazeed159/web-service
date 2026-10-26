// MarketDate: "today" must follow New York, not the device's timezone (run: node --test tests/market-date.test.js)
const test = require("node:test");
const assert = require("node:assert/strict");
const MD = require("../js/app-boot.js");

test("after-hours trade that is already 'tomorrow' in Cairo still lands on the US trading day", () => {
  // 22:30 UTC = 18:30 New York (EDT) = 01:30 next day in Cairo (UTC+3)
  assert.equal(MD.etDate(new Date("2026-10-25T22:30:00Z")), "2026-10-25");
});

test("pre-market the next morning is the next US date", () => {
  assert.equal(MD.etDate(new Date("2026-10-26T08:30:00Z")), "2026-10-26"); // 04:30 ET
});

test("late evening ET is still the same US date (8pm ET close of after-hours)", () => {
  assert.equal(MD.etDate(new Date("2026-10-26T01:30:00Z")), "2026-10-25"); // 21:30 ET on the 25th
  assert.equal(MD.etDate(new Date("2026-10-26T03:59:00Z")), "2026-10-25"); // 23:59 ET
  assert.equal(MD.etDate(new Date("2026-10-26T04:00:00Z")), "2026-10-26"); // 00:00 ET
});

test("follows daylight saving: winter offset is UTC-5", () => {
  assert.equal(MD.etDate(new Date("2026-12-15T04:59:00Z")), "2026-12-14"); // 23:59 EST
  assert.equal(MD.etDate(new Date("2026-12-15T05:00:00Z")), "2026-12-15"); // 00:00 EST
});

test("DST switch day (Nov 1 2026, clocks go back at 2am)", () => {
  assert.equal(MD.etDate(new Date("2026-11-01T05:30:00Z")), "2026-11-01"); // 01:30 EDT
  assert.equal(MD.etDate(new Date("2026-11-02T04:59:00Z")), "2026-11-01"); // 23:59 EST
});

test("etTime formats HH:MM and midnight is 00 not 24", () => {
  assert.equal(MD.etTime(new Date("2026-10-26T04:05:00Z")), "00:05");
  assert.equal(MD.etTime(new Date("2026-10-25T13:30:00Z")), "09:30");
});

test("addDays is plain calendar arithmetic", () => {
  assert.equal(MD.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(MD.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(MD.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(MD.addDays("bad", 1), "bad");
});

test("today() matches etDate(now)", () => {
  assert.equal(MD.today(), MD.etDate(new Date()));
});
