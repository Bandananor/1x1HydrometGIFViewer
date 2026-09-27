import crypto from 'node:crypto';
import express from 'express';
import sharp from 'sharp';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SOURCE_URL = process.env.SOURCE_URL || 'https://meteoinfo.ru/hmc-output/rmap/phenomena.gif';
const STALE_AFTER_MS = Number(process.env.STALE_AFTER_MINUTES || 35) * 60_000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 25_000);
const MIN_MANUAL_REFRESH_INTERVAL_MS = 30_000;

let snapshot = null;
let refreshPromise = null;
let lastAttemptAt = null;
let lastError = null;
let lastManualRefreshAt = 0;

const noStore = (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
  next();
};

function isStale() {
  return !snapshot || Date.now() - snapshot.contentChangedAt.getTime() > STALE_AFTER_MS;
}

async function gifToFrames(buffer) {
  const input = sharp(buffer, { animated: true, pages: -1, limitInputPixels: false });
  const metadata = await input.metadata();
  const pageCount = metadata.pages || 1;
  const pageHeight = metadata.pageHeight || metadata.height;
  const { data, info } = await input.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frameBytes = info.width * pageHeight * info.channels;
  const frames = await Promise.all(Array.from({ length: pageCount }, async (_, index) => {
    const page = data.subarray(index * frameBytes, (index + 1) * frameBytes);
    return sharp(page, {
      raw: { width: info.width, height: pageHeight, channels: info.channels }
    }).png({ compressionLevel: 8 }).toBuffer();
  }));

  return {
    frames,
    width: info.width,
    height: pageHeight,
    delays: Array.isArray(metadata.delay) ? metadata.delay : []
  };
}

async function refresh(reason = 'scheduled') {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    lastAttemptAt = new Date();
    try {
      const url = new URL(SOURCE_URL);
      url.searchParams.set('_fresh', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Accept: 'image/gif,*/*;q=0.8',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
          'User-Agent': 'MeteoinfoFrameViewer/1.0'
        }
      });
      if (!response.ok) throw new Error(`Источник ответил HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 100 || (!type.includes('gif') && buffer.subarray(0, 3).toString() !== 'GIF')) {
        throw new Error('Источник вернул не GIF-изображение');
      }

      const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      const unchanged = snapshot?.hash === hash;
      let decoded = snapshot;
      if (!unchanged) decoded = await gifToFrames(buffer);

      const now = new Date();
      snapshot = {
        ...decoded,
        hash,
        version: hash,
        fetchedAt: now,
        contentChangedAt: unchanged ? snapshot.contentChangedAt : now,
        sourceLastModified: response.headers.get('last-modified'),
        sourceEtag: response.headers.get('etag'),
        refreshReason: reason
      };
      lastError = null;
      console.log(`[refresh] ${reason}: ${unchanged ? 'без изменений' : `${snapshot.frames.length} кадров`}, ${hash}`);
      return snapshot;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`[refresh] ${reason}: ${lastError}`);
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function publicStatus() {
  return {
    ready: Boolean(snapshot),
    stale: isStale(),
    refreshing: Boolean(refreshPromise),
    version: snapshot?.version || null,
    frameCount: snapshot?.frames.length || 0,
    width: snapshot?.width || null,
    height: snapshot?.height || null,
    delays: snapshot?.delays || [],
    fetchedAt: snapshot?.fetchedAt?.toISOString() || null,
    contentChangedAt: snapshot?.contentChangedAt?.toISOString() || null,
    sourceLastModified: snapshot?.sourceLastModified || null,
    lastAttemptAt: lastAttemptAt?.toISOString() || null,
    lastError,
    staleAfterMinutes: STALE_AFTER_MS / 60_000,
    nextRefreshAt: nextBoundary().toISOString()
  };
}

function nextBoundary(from = new Date()) {
  const next = new Date(from);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  while (next.getUTCMinutes() % 10 !== 3) next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next;
}

function scheduleRefresh() {
  const next = nextBoundary();
  const delay = Math.max(0, next.getTime() - Date.now());
  console.log(`[scheduler] следующее обновление: ${next.toISOString()}`);
  setTimeout(async () => {
    try { await refresh('scheduled'); } catch { /* статус ошибки уже сохранён */ }
    scheduleRefresh();
  }, delay);
}

app.disable('etag');
app.use(express.json());
app.use('/api', noStore);

app.get('/api/status', (_req, res) => res.json(publicStatus()));

app.get('/api/manifest', (_req, res) => {
  if (!snapshot) return res.status(503).json({ error: 'Данные ещё загружаются', ...publicStatus() });
  if (isStale()) return res.status(503).json({ error: 'Источник давно не менялся. Старые кадры скрыты.', ...publicStatus() });
  res.json({
    ...publicStatus(),
    frames: snapshot.frames.map((_, index) => `/api/frame/${snapshot.version}/${index}.png`)
  });
});

app.get('/api/frame/:version/:index.png', (req, res) => {
  const index = Number(req.params.index);
  if (!snapshot || isStale() || req.params.version !== snapshot.version || !Number.isInteger(index) || !snapshot.frames[index]) {
    return res.status(404).json({ error: 'Кадр устарел или не найден' });
  }
  res.type('png').send(snapshot.frames[index]);
});

app.post('/api/refresh', async (_req, res) => {
  const now = Date.now();
  if (now - lastManualRefreshAt < MIN_MANUAL_REFRESH_INTERVAL_MS) {
    return res.status(429).json({ error: 'Обновлять вручную можно раз в 30 секунд', ...publicStatus() });
  }
  lastManualRefreshAt = now;
  try {
    await refresh('manual');
    res.json(publicStatus());
  } catch {
    res.status(502).json({ error: lastError, ...publicStatus() });
  }
});

app.get('/health', (_req, res) => res.status(snapshot && !isStale() ? 200 : 503).json(publicStatus()));
app.use(express.static('public', { etag: false, maxAge: 0, setHeaders: res => res.set('Cache-Control', 'no-cache') }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сайт запущен: http://localhost:${PORT}`);
  refresh('startup').catch(() => {});
  scheduleRefresh();
});
