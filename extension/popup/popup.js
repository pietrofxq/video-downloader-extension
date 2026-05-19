const gear = document.getElementById('open-options');
gear?.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

// v0.4 will query the SW for detected media via GET_TAB_STATE and render rows.
// For v0.1 we just show the empty state baked into popup.html.
