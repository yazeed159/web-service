(function () {
  "use strict";
  const R = (App.reports = App.reports || {});

  // Reports tab of index.html. Split out of the old app.js -- see the big
  // comment at the top of app-shared.js (loaded right before this file on
  // every navigation here) for how these files fit together. Reads/writes
  // shared trade data via `App.state` (including the temporary filtered-
  // subset swap in applyReportFiltersAndRender below -- see its comment);
  // registers its two entry points on `App.tabs.reports` so app-shared.js's
  // fetch-then-render pass can call them once data loads.

  // Report-only filter/view state -- never read outside this file.
  // Defaults for the "Advanced" filters (side / result / P&L, price and
  // share ranges / entry time / weekday). Spread into every place a fresh
  // filter object is built so "no filter" is defined in exactly one spot.
  const ADV_DEFAULTS = {
    side: "all", result: "all",
    pnlMin: null, pnlMax: null, priceMin: null, priceMax: null, sharesMin: null, sharesMax: null,
    timeFrom: "", timeTo: "",
  };
  // Unique-id counter for every trade-list toggle row this tab renders
  // (symbol/DOW/time-of-day/duration breakdowns, leaderboards, sector/
  // country, win/loss days, detail lessons/distribution -- anywhere a
  // row expands into its underlying trades via data-trade-toggle). Was
  // missing its declaration entirely -- every `reportRowSeq++` below
  // threw a ReferenceError under this file's "use strict", which
  // safeRender (app-shared.js) quietly caught, leaving each of those
  // sections stuck on "Loading…" and then swept into the generic
  // "Couldn't load this section" placeholder.
  let reportRowSeq = 0;

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  Object.assign(R, { ADV_DEFAULTS, DOW });
})();
