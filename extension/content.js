let isAltPressed = false;
window.addEventListener("keydown", (e) => {
  if ((e.key === "Alt" || e.key === "Shift") && !isAltPressed) {
    isAltPressed = true;
    chrome.runtime.sendMessage({ action: "bypass_next" }).catch(() => {
    });
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt" || e.key === "Shift") {
    isAltPressed = false;
  }
});
window.addEventListener("click", (e) => {
  if (e.shiftKey || e.altKey) {
    chrome.runtime.sendMessage({ action: "bypass_next" }).catch(() => {
    });
  }
}, true);
