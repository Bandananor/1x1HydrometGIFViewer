const $ = id => document.getElementById(id);
const ui = {
  viewer: $('viewer'), stage: $('stage'), image: $('frameImage'), empty: $('emptyState'), slider: $('frameSlider'),
  current: $('currentFrame'), total: $('totalFrames'), updated: $('updatedAt'), statusText: $('statusText'), statusDot: $('statusDot'),
  refresh: $('refreshButton'), toast: $('toast'), play: $('playButton'), playIcon: $('playIcon'), zoomValue: $('zoomValue')
};

let manifest = null;
let frameBlobs = [];
let index = 0;
let playing = false;
let playTimer = null;
let scale = 1, panX = 0, panY = 0;
let fitScale = 1, userZoomed = false;
let pointers = new Map();
let dragStart = null, pinchStart = null;
let toastTimer;

function toast(message) {
  ui.toast.textContent = message; ui.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3500);
}

function setStatus(kind, text) {
  ui.statusDot.className = `status-dot ${kind || ''}`; ui.statusText.textContent = text;
}

function updateTransform() {
  ui.stage.style.transform = `translate3d(${panX}px,${panY}px,0) scale(${scale})`;
  ui.zoomValue.textContent = `${Math.round(scale * 100)}%`;
}

function setZoom(next, centerX = 0, centerY = 0, userAction = true) {
  const old = scale; scale = Math.max(.1, Math.min(5, next));
  if (userAction) userZoomed = true;
  if (old !== scale && centerX && centerY) {
    const rect = ui.viewer.getBoundingClientRect();
    const x = centerX - rect.left - rect.width / 2, y = centerY - rect.top - rect.height / 2;
    panX -= x * (scale / old - 1); panY -= y * (scale / old - 1);
  }
  if (scale === 1) panX = panY = 0;
  updateTransform();
}

function fitToView() {
  if (!manifest?.width || !manifest?.height) return;
  const rect = ui.viewer.getBoundingClientRect();
  fitScale = Math.min((rect.width - 32) / manifest.width, (rect.height - 32) / manifest.height, 1);
  scale = Math.max(.1, fitScale); panX = panY = 0; userZoomed = false; updateTransform();
}

function resetZoom() { scale = 1; panX = panY = 0; userZoomed = true; updateTransform(); }

function showFrame(next) {
  if (!manifest?.frameCount) return;
  index = (next + manifest.frameCount) % manifest.frameCount;
  ui.image.src = frameBlobs[index] || manifest.frames[index];
  ui.current.textContent = index + 1; ui.slider.value = index;
}

function stopPlayback() { playing = false; clearTimeout(playTimer); ui.playIcon.textContent = '▶'; ui.play.setAttribute('aria-label', 'Запустить анимацию'); }
function playbackTick() {
  if (!playing || !manifest) return;
  showFrame(index + 1);
  const delay = Math.max(150, Math.min(2000, manifest.delays?.[index] || 500));
  playTimer = setTimeout(playbackTick, delay);
}
function togglePlayback() { playing = !playing; ui.playIcon.textContent = playing ? 'Ⅱ' : '▶'; ui.play.setAttribute('aria-label', playing ? 'Остановить анимацию' : 'Запустить анимацию'); if (playing) playbackTick(); else clearTimeout(playTimer); }

async function preloadFrames(data) {
  const urls = await Promise.all(data.frames.map(async url => {
    const response = await fetch(`${url}?v=${data.version}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Один из кадров уже устарел');
    return URL.createObjectURL(await response.blob());
  }));
  frameBlobs.forEach(URL.revokeObjectURL); frameBlobs = urls;
}

function applyManifest(data) {
  const changed = manifest?.version !== data.version;
  manifest = data; index = Math.min(index, data.frameCount - 1);
  ui.image.width = data.width; ui.image.height = data.height;
  ui.slider.max = data.frameCount - 1; ui.slider.disabled = false; ui.total.textContent = data.frameCount;
  ui.updated.textContent = new Date(data.fetchedAt).toLocaleTimeString('ru-RU', { timeZone:'UTC', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  ui.empty.classList.add('hidden'); ui.image.classList.add('ready'); showFrame(index);
  setStatus('', `Свежие данные · ${data.frameCount} кадров`);
  document.querySelectorAll('.frame-controls button').forEach(button => button.disabled = false);
  if (changed) fitToView();
  if (changed) toast('Загружена свежая версия карты');
}

function showUnavailable(message) {
  stopPlayback(); manifest = null; frameBlobs.forEach(URL.revokeObjectURL); frameBlobs = [];
  ui.image.classList.remove('ready'); ui.image.removeAttribute('src'); ui.empty.classList.remove('hidden');
  ui.empty.querySelector('strong').textContent = 'Карта временно недоступна'; ui.empty.querySelector('span').textContent = message;
  setStatus('error', 'Нет свежих данных'); ui.slider.disabled = true;
}

async function loadManifest({ quiet = false } = {}) {
  try {
    const response = await fetch(`/api/manifest?_=${Date.now()}`, { cache:'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось получить карту');
    if (manifest?.version === data.version && frameBlobs.length === data.frameCount) { applyManifest(data); return; }
    await preloadFrames(data); applyManifest(data);
  } catch (error) {
    showUnavailable(error.message); if (!quiet) toast(error.message);
  }
}

async function manualRefresh() {
  ui.refresh.disabled = true; ui.refresh.classList.add('spinning'); setStatus('loading', 'Проверяем источник…');
  try {
    const response = await fetch('/api/refresh', { method:'POST', cache:'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Ошибка обновления');
    await loadManifest();
  } catch (error) { toast(error.message); await loadManifest({ quiet:true }); }
  finally { ui.refresh.disabled = false; ui.refresh.classList.remove('spinning'); }
}

$('prevFrame').onclick = () => { stopPlayback(); showFrame(index - 1); };
$('nextFrame').onclick = () => { stopPlayback(); showFrame(index + 1); };
$('firstFrame').onclick = () => { stopPlayback(); showFrame(0); };
$('lastFrame').onclick = () => { stopPlayback(); showFrame((manifest?.frameCount || 1) - 1); };
ui.play.onclick = togglePlayback; ui.slider.oninput = event => { stopPlayback(); showFrame(Number(event.target.value)); };
ui.refresh.onclick = manualRefresh; $('zoomIn').onclick = () => setZoom(scale * 1.25); $('zoomOut').onclick = () => setZoom(scale / 1.25); $('resetZoom').onclick = resetZoom;

ui.viewer.addEventListener('wheel', event => { event.preventDefault(); setZoom(scale * (event.deltaY < 0 ? 1.13 : .885), event.clientX, event.clientY); }, { passive:false });
ui.viewer.addEventListener('dblclick', event => setZoom(scale >= .99 ? fitScale : 1, event.clientX, event.clientY));
document.querySelector('.zoom-controls').addEventListener('pointerdown', event => event.stopPropagation());
document.querySelector('.zoom-controls').addEventListener('dblclick', event => event.stopPropagation());
document.querySelector('.zoom-controls').addEventListener('wheel', event => event.stopPropagation(), { passive:true });
ui.viewer.addEventListener('pointerdown', event => {
  ui.viewer.setPointerCapture(event.pointerId); pointers.set(event.pointerId, { x:event.clientX, y:event.clientY });
  if (pointers.size === 1) dragStart = { x:event.clientX, y:event.clientY, panX, panY };
  if (pointers.size === 2) { const [a,b] = [...pointers.values()]; pinchStart = { distance:Math.hypot(a.x-b.x,a.y-b.y), scale }; }
});
ui.viewer.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return; pointers.set(event.pointerId, { x:event.clientX,y:event.clientY });
  if (pointers.size === 2 && pinchStart) { const [a,b] = [...pointers.values()]; setZoom(pinchStart.scale * Math.hypot(a.x-b.x,a.y-b.y) / pinchStart.distance, (a.x+b.x)/2, (a.y+b.y)/2); }
  else if (dragStart) { panX = dragStart.panX + event.clientX-dragStart.x; panY = dragStart.panY + event.clientY-dragStart.y; updateTransform(); }
});
function pointerEnd(event) {
  pointers.delete(event.pointerId);
  dragStart = pointers.size === 1 ? { ...[...pointers.values()][0], panX, panY } : null; pinchStart = null;
}
ui.viewer.addEventListener('pointerup', pointerEnd); ui.viewer.addEventListener('pointercancel', pointerEnd);
document.addEventListener('keydown', event => { if (event.key === 'ArrowLeft') { stopPlayback(); showFrame(index-1); } if (event.key === 'ArrowRight') { stopPlayback(); showFrame(index+1); } if (event.key === ' ') { event.preventDefault(); togglePlayback(); } });
window.addEventListener('resize', () => { if (!userZoomed) fitToView(); });

loadManifest();
setInterval(() => loadManifest({ quiet:true }), 60_000);
