// Plays the page's <video> the way a site's JS player would, so the
// extension's fetch/XHR hooks and webRequest listeners see realistic traffic.
const video = document.querySelector('video');
const status = document.getElementById('status');
const hlsSrc = video.dataset.hls;

if (hlsSrc) {
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_event, data) => {
      status.textContent = `manifest parsed: ${data.levels.length} level(s)`;
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) status.textContent = `hls.js fatal error: ${data.details}`;
    });
    hls.loadSource(hlsSrc);
    hls.attachMedia(video);
  } else {
    status.textContent = 'hls.js unavailable';
  }
}

video.addEventListener('playing', () => {
  status.textContent += ' · playing';
});
video.play().catch((err) => {
  status.textContent += ` · autoplay blocked: ${err.name}`;
});
