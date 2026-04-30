const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const path = require('path');
const crypto = require('crypto');
const YouTube = require('youtube-sr').default;
const { execFile } = require('child_process');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Serve downloaded media files
const mediaDir = path.join(__dirname, 'media');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir);
app.use('/media', express.static(mediaDir));

// Config endpoint for frontend
const BASE_URL = process.env.BASE_URL || '';
app.get('/api/config', (req, res) => {
  res.json({ baseUrl: BASE_URL });
});

// In-memory store for jam sessions
const jams = new Map();

function createJam(password) {
  const id = nanoid(8).toUpperCase();
  const adminToken = nanoid(16);
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  const jam = {
    id,
    adminToken,
    passwordHash,
    queue: [],
    currentIndex: 0,
    isPlaying: false,
    showQr: true,
    createdAt: Date.now(),
  };
  jams.set(id, jam);
  return jam;
}

function getPublicJamState(jam) {
  return {
    id: jam.id,
    queue: jam.queue.map(v => ({
      id: v.id,
      videoId: v.videoId,
      title: v.title,
      thumbnail: v.thumbnail,
      addedBy: v.addedBy,
      status: v.status,
      mediaUrl: v.mediaUrl || null,
    })),
    currentIndex: jam.currentIndex,
    isPlaying: jam.isPlaying,
    showQr: jam.showQr !== false,
  };
}

// --- Download with yt-dlp ---

function downloadVideo(videoId, queueItem, jamId) {
  const outputPath = path.join(mediaDir, `${videoId}.mp4`);

  // Already downloaded
  if (fs.existsSync(outputPath)) {
    queueItem.status = 'ready';
    queueItem.mediaUrl = `/media/${videoId}.mp4`;
    const jam = jams.get(jamId);
    if (jam) io.to(jamId).emit('jam-state', getPublicJamState(jam));
    return;
  }

  queueItem.status = 'downloading';

  const args = [
    '-f', 'bestvideo[vcodec^=avc][height<=720]+bestaudio[acodec^=mp4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--postprocessor-args', 'ffmpeg:-vcodec libx264 -acodec aac',
    '-o', outputPath,
    '--no-playlist',
    '--no-warnings',
    'https://www.youtube.com/watch?v=' + videoId,
  ];

  console.log('[yt-dlp] Downloading ' + videoId + '...');

  execFile('yt-dlp', args, { timeout: 300000 }, (err, stdout, stderr) => {
    const jam = jams.get(jamId);
    if (!jam) return;

    if (err) {
      console.error('[yt-dlp] Error ' + videoId + ':', stderr || err.message);
      try { fs.unlinkSync(outputPath); } catch(e) {}
      queueItem.status = 'error';
    } else {
      console.log('[yt-dlp] Ready: ' + videoId);
      queueItem.status = 'ready';
      queueItem.mediaUrl = '/media/' + videoId + '.mp4';
    }

    io.to(jamId).emit('jam-state', getPublicJamState(jam));
  });
}

// --- REST API ---

app.post('/api/jams', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!password || password.length < 1) {
    return res.status(400).json({ error: 'Se requiere una contraseña' });
  }
  const jam = createJam(password);
  res.json({ id: jam.id, adminToken: jam.adminToken });
});

app.post('/api/jams/:id/auth', (req, res) => {
  const jam = jams.get(req.params.id.toUpperCase());
  if (!jam) return res.status(404).json({ error: 'Jam no encontrada' });
  const password = (req.body && req.body.password) || '';
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  if (hash !== jam.passwordHash) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  res.json({ adminToken: jam.adminToken });
});

app.get('/api/jams/:id', (req, res) => {
  const jam = jams.get(req.params.id.toUpperCase());
  if (!jam) return res.status(404).json({ error: 'Jam not found' });
  res.json(getPublicJamState(jam));
});

app.get('/api/search', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const results = await YouTube.search(q, { limit: 8, type: 'video' });
    res.json(results.map(v => ({
      videoId: v.id,
      title: v.title,
      thumbnail: v.thumbnail?.url || ('https://img.youtube.com/vi/' + v.id + '/mqdefault.jpg'),
      duration: v.durationFormatted || '',
      channel: v.channel?.name || '',
      cached: fs.existsSync(path.join(mediaDir, `${v.id}.mp4`)),
    })));
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// --- Pages ---

function sendJamPage(req, res, page) {
  const jam = jams.get(req.params.id.toUpperCase());
  if (!jam) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'public', page));
}

app.get('/jam/:id/player', (req, res) => sendJamPage(req, res, 'player.html'));
app.get('/jam/:id/admin',  (req, res) => sendJamPage(req, res, 'admin.html'));
app.get('/jam/:id',        (req, res) => sendJamPage(req, res, 'queue.html'));

// --- Socket.IO ---

io.on('connection', (socket) => {
  let currentJamId = null;

  socket.on('join-jam', ({ jamId, role, adminToken }) => {
    const normalizedJamId = String(jamId || '').toUpperCase();
    const jam = jams.get(normalizedJamId);
    if (!jam) {
      socket.emit('error-msg', 'Jam not found');
      return;
    }

    if (role === 'admin' && adminToken !== jam.adminToken) {
      socket.emit('error-msg', 'Invalid admin token');
      return;
    }

    currentJamId = normalizedJamId;
    socket.join(normalizedJamId);
    socket.role = role;
    socket.emit('jam-state', getPublicJamState(jam));
  });

  // --- Queue operations (anyone) ---

  socket.on('add-video', ({ videoId, title, thumbnail, addedBy }) => {
    const jam = jams.get(currentJamId);
    if (!jam) return;

    const sanitizedVideoId = String(videoId).substring(0, 20);

    // Check if same video already downloaded in this jam
    const existing = jam.queue.find(v => v.videoId === sanitizedVideoId && v.status === 'ready');

    const queueItem = {
      id: nanoid(6),
      videoId: sanitizedVideoId,
      title: String(title).substring(0, 200),
      thumbnail: String(thumbnail).substring(0, 300),
      addedBy: String(addedBy || 'Anon').substring(0, 30),
      status: 'downloading',
      mediaUrl: null,
    };

    if (existing) {
      queueItem.status = 'ready';
      queueItem.mediaUrl = existing.mediaUrl;
    }

    jam.queue.push(queueItem);
    io.to(currentJamId).emit('jam-state', getPublicJamState(jam));

    if (queueItem.status !== 'ready') {
      downloadVideo(sanitizedVideoId, queueItem, currentJamId);
    }
  });

  // --- Admin-only operations ---

  function isAdmin() {
    return socket.role === 'admin';
  }

  socket.on('play', () => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    jam.isPlaying = true;
    io.to(currentJamId).emit('player-command', { action: 'play' });
    io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
  });

  socket.on('pause', () => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    jam.isPlaying = false;
    io.to(currentJamId).emit('player-command', { action: 'pause' });
    io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
  });

  socket.on('toggle-qr', ({ show }) => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    jam.showQr = !!show;
    io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
  });

  socket.on('next', () => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    if (jam.currentIndex < jam.queue.length - 1) {
      jam.currentIndex++;
      io.to(currentJamId).emit('player-command', { action: 'load', index: jam.currentIndex });
      io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
    }
  });

  socket.on('prev', () => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    if (jam.currentIndex > 0) {
      jam.currentIndex--;
      io.to(currentJamId).emit('player-command', { action: 'load', index: jam.currentIndex });
      io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
    }
  });

  socket.on('play-index', (index) => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    if (index >= 0 && index < jam.queue.length) {
      jam.currentIndex = index;
      io.to(currentJamId).emit('player-command', { action: 'load', index: jam.currentIndex });
      io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
    }
  });

  socket.on('move-video', ({ fromIndex, toIndex }) => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    if (fromIndex < 0 || fromIndex >= jam.queue.length) return;
    if (toIndex < 0 || toIndex >= jam.queue.length) return;

    const [item] = jam.queue.splice(fromIndex, 1);
    jam.queue.splice(toIndex, 0, item);

    if (jam.currentIndex === fromIndex) {
      jam.currentIndex = toIndex;
    } else if (fromIndex < jam.currentIndex && toIndex >= jam.currentIndex) {
      jam.currentIndex--;
    } else if (fromIndex > jam.currentIndex && toIndex <= jam.currentIndex) {
      jam.currentIndex++;
    }

    io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
  });

  socket.on('remove-video', (index) => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    if (index < 0 || index >= jam.queue.length) return;

    jam.queue.splice(index, 1);

    if (jam.currentIndex >= jam.queue.length) {
      jam.currentIndex = Math.max(0, jam.queue.length - 1);
    } else if (index < jam.currentIndex) {
      jam.currentIndex--;
    }

    io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
  });

  socket.on('video-ended', () => {
    const jam = jams.get(currentJamId);
    if (!jam) return;
    if (jam.currentIndex < jam.queue.length - 1) {
      jam.currentIndex++;
      io.to(currentJamId).emit('player-command', { action: 'load', index: jam.currentIndex });
      io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
    } else {
      jam.isPlaying = false;
      io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
    }
  });

  socket.on('player-status', (data) => {
    if (socket.role !== 'player') return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    if (jam.isPlaying !== data.isPlaying) {
      jam.isPlaying = data.isPlaying;
      io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
    }
  });

  socket.on('seek', (time) => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;
    io.to(currentJamId).emit('player-command', { action: 'seek', time });
  });
});

// Cleanup old jams every hour
setInterval(() => {
  const now = Date.now();
  const MAX_AGE = 12 * 60 * 60 * 1000;
  for (const [id, jam] of jams) {
    if (now - jam.createdAt > MAX_AGE) {
      jams.delete(id);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('YTJam server running on http://localhost:' + PORT);
});
