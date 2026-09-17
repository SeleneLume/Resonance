let isPlaying = false;
let lastKey = null;
let waveRunning = false;

function setLayerContent(suffix, state) {
  document.getElementById('art' + suffix).src = state.artworkDataUrl || '';
  document.getElementById('title' + suffix).textContent = state.title || 'Nothing playing';
  document.getElementById('artist' + suffix).textContent = state.artist || '—';
}

function setBarFill(suffix, pct) {
  document.getElementById('barFill' + suffix).style.width = pct + '%';
}

// Builds a wavy vertical clip edge (in objectBoundingBox units 0..1) at the given
// horizontal progress, with a ripple that's strongest mid-transition and settles
// flat at both ends so the reveal starts and finishes cleanly.
function buildWavePath(progress) {
  const points = 10;
  const amp = 0.055;
  const wobbleEnvelope = Math.sin(progress * Math.PI); // 0 at start/end, peaks mid-transition
  const coords = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    const wobble = Math.sin(t * Math.PI * 3 + progress * 9) * amp * wobbleEnvelope;
    const x = Math.min(1, Math.max(0, progress + wobble));
    coords.push(x.toFixed(4) + ',' + t.toFixed(4));
  }
  let d = 'M ' + coords[0] + ' ';
  for (let i = 1; i < coords.length; i++) d += 'L ' + coords[i] + ' ';
  d += 'L 1,1 L 1,0 Z';
  return d;
}

function triggerWaveTransition(newState) {
  setLayerContent('New', newState);
  setBarFill('New', newState.duration ? (newState.currentTime / newState.duration) * 100 : 0);
  waveRunning = true;
  const start = performance.now();
  const duration = 800;
  const wavePath = document.getElementById('wavePath');

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    wavePath.setAttribute('d', buildWavePath(eased));
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      setLayerContent('Old', newState);
      setBarFill('Old', newState.duration ? (newState.currentTime / newState.duration) * 100 : 0);
      wavePath.setAttribute('d', 'M0,0 L0,0 L0,1 L0,1 Z'); // reset: new layer fully hidden again, ready for next transition
      waveRunning = false;
    }
  }
  requestAnimationFrame(frame);
}

window.api.onMiniPlayerState((state) => {
  const key = (state.title || '') + '|' + (state.artist || '');

  if (lastKey === null) {
    setLayerContent('Old', state);
    lastKey = key;
  } else if (key !== lastKey && !waveRunning) {
    lastKey = key;
    triggerWaveTransition(state);
  }

  isPlaying = state.isPlaying;
  document.getElementById('playBtn').classList.toggle('is-playing', isPlaying);

  const pct = state.duration ? (state.currentTime / state.duration) * 100 : 0;
  if (!waveRunning) {
    setBarFill('Old', pct);
    setBarFill('New', pct);
  }
});

document.getElementById('playBtn').addEventListener('click', () => window.api.sendMiniCommand('playPause'));
document.getElementById('nextBtn').addEventListener('click', () => window.api.sendMiniCommand('next'));
document.getElementById('prevBtn').addEventListener('click', () => window.api.sendMiniCommand('prev'));
document.getElementById('closeBtn').addEventListener('click', () => window.api.closeMiniPlayer());

// Keep the wave/bar visuals frame-accurate even if the main process throttles
// the periodic state push (e.g. while the OS is busy) — this doesn't affect
// the "always on top" behavior below, just perceived smoothness.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); window.api.sendMiniCommand('playPause'); }
});
