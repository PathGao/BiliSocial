// Marks the B站 video page when it is the #feed viewer's iframe inside this extension, so viewer-frame.css trims it to
// the player, the description and the comments. Pages opened any other way are left alone.
if (window !== window.top && location.ancestorOrigins?.[0] === new URL(chrome.runtime.getURL("")).origin) {
  document.documentElement.setAttribute("data-bs-viewer", "");
}
