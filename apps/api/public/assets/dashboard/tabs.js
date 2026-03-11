export function initTabs() {
  const tablist = document.querySelector('.dashboard-tabs');
  const sidebarNav = document.querySelector('.sidebar-nav');
  const tabBtns = tablist ? tablist.querySelectorAll('.dashboard-tab-btn') : [];
  const sidebarBtns = sidebarNav ? sidebarNav.querySelectorAll('.sidebar-nav-btn[data-tab]') : [];
  const panels = document.querySelectorAll('.dashboard-tab-panel');

  function switchTo(tabId) {
    const allTabTriggers = [...tabBtns, ...sidebarBtns];
    allTabTriggers.forEach((t) => {
      const isActive = t.getAttribute('data-tab') === tabId;
      t.classList.toggle('is-active', isActive);
      t.setAttribute('aria-selected', isActive);
    });
    panels.forEach((p) => {
      const targetId = p.id;
      const tab = document.querySelector(`[aria-controls="${targetId}"]`);
      const isActive = tab && tab.getAttribute('data-tab') === tabId;
      p.classList.toggle('is-active', isActive);
    });
  }

  tabBtns.forEach((t) => t.addEventListener('click', () => switchTo(t.getAttribute('data-tab'))));
  sidebarBtns.forEach((t) => t.addEventListener('click', () => switchTo(t.getAttribute('data-tab'))));
  window.switchToTab = switchTo;
}
