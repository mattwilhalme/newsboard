(function initNewsboardDrawers(global) {
  "use strict";

  function createDrawerManager({ drawerIds, overlayId = "drawer-overlay", beforeClose } = {}) {
    const ids = Array.isArray(drawerIds) ? drawerIds : [];
    const overlay = () => document.getElementById(overlayId);
    const getOpenDrawer = () => ids
      .map((id) => document.getElementById(id))
      .find((drawer) => drawer?.classList.contains("open")) || null;

    function closeAll() {
      beforeClose?.();
      for (const id of ids) {
        const drawer = document.getElementById(id);
        if (!drawer) continue;
        drawer.classList.remove("open");
        drawer.setAttribute("aria-hidden", "true");
      }
      overlay()?.classList.remove("show");
    }

    function open(id, { focusId } = {}) {
      const drawer = document.getElementById(id);
      if (!drawer) return null;
      closeAll();
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
      overlay()?.classList.add("show");
      document.getElementById(focusId)?.focus();
      return drawer;
    }

    function handleKeydown(event) {
      const drawer = getOpenDrawer();
      if (event.key === "Escape" && drawer) {
        closeAll();
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const nodes = [...drawer.querySelectorAll('button:not([disabled]),a[href],[tabindex="0"]')]
        .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    overlay()?.addEventListener("click", closeAll);
    document.addEventListener("keydown", handleKeydown);

    return { closeAll, getOpenDrawer, open };
  }

  global.NewsboardDrawers = { createDrawerManager };
})(window);
