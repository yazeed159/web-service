// nav.js — shared sidebar/mobile-nav wiring for every page.
//
// Every page ships the same app-shell sidebar (#sidebar), a desktop
// collapse toggle (#sidebar-toggle), and a mobile hamburger button
// (#mobile-nav-btn) in the topbar. This used to be ~20 lines of
// identical inline <script> duplicated across nine pages, and three
// more pages (practice.html, quiz.html, rewind.html) shipped the
// hamburger button with no wiring at all, so tapping it did nothing.
// This file is the single implementation, loaded by every page.
(function () {
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const mobileNavBtn = document.getElementById("mobile-nav-btn");
  if (!sidebar) return; // page doesn't use the app-shell sidebar

  const sidebarBackdrop = document.createElement("div");
  sidebarBackdrop.className = "sidebar-backdrop";
  document.body.appendChild(sidebarBackdrop);

  function closeMobileNav() {
    sidebar.classList.remove("mobile-open");
  }

  sidebarBackdrop.addEventListener("click", closeMobileNav);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMobileNav();
  });

  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
      if (window.innerWidth <= 760 && sidebar.classList.contains("mobile-open")) {
        closeMobileNav();
      } else {
        sidebar.classList.toggle("collapsed");
      }
    });
  }

  if (mobileNavBtn) {
    mobileNavBtn.addEventListener("click", () => {
      sidebar.classList.toggle("mobile-open");
    });
  }

  // Exposed so pages with their own tab-switching logic (index.html)
  // can close the mobile drawer on navigation without re-implementing it.
  window.closeMobileNav = closeMobileNav;
})();
