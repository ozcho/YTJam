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
    activeDownloads: 0,
    pendingDownloads: [],
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
      progress: v.progress !== undefined ? v.progress : 0,
    })),
    currentIndex: jam.currentIndex,
    isPlaying: jam.isPlaying,
    showQr: jam.showQr !== false,
  };
}

// --- Download queue management ---

function startNextDownload(jamId) {
  const jam = jams.get(jamId);
  if (!jam) return;
  
  // Iniciar descargas mientras haya espacio y videos pendientes
  while (jam.activeDownloads < 3 && jam.pendingDownloads.length > 0) {
    const { videoId, queueItem } = jam.pendingDownloads.shift();
    jam.activeDownloads++;
    downloadVideo(videoId, queueItem, jamId);
  }
}

function downloadVideo(videoId, queueItem, jamId) {
  const outputPath = path.join(mediaDir, `${videoId}.mp4`);

  // Already downloaded
  if (fs.existsSync(outputPath)) {
    queueItem.status = 'ready';
    queueItem.mediaUrl = `/media/${videoId}.mp4`;
    queueItem.progress = 100;
    const jam = jams.get(jamId);
    if (jam) {
      jam.activeDownloads--;
      io.to(jamId).emit('jam-state', getPublicJamState(jam));
      startNextDownload(jamId);
    }
    return;
  }

  // Cambiar a "downloading" cuando realmente inicia
  queueItem.status = 'downloading';
  queueItem.progress = 0;

  const args = [
    '-f', 'bestvideo[vcodec^=avc][height<=720]+bestaudio[acodec^=mp4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--postprocessor-args', 'ffmpeg:-vcodec libx264 -acodec aac',
    '-o', outputPath,
    '--no-playlist',
    '--no-warnings',
    '--progress-template', '[download] %(progress._percent_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s',
    'https://www.youtube.com/watch?v=' + videoId,
  ];

  console.log('[yt-dlp] Downloading ' + videoId + '...');
  
  const jam = jams.get(jamId);
  if (jam) io.to(jamId).emit('jam-state', getPublicJamState(jam));

  const child = execFile('yt-dlp', args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
      queueItem.progress = 100;
    }

    jam.activeDownloads--;
    io.to(jamId).emit('jam-state', getPublicJamState(jam));
    startNextDownload(jamId);
  });

  // Capturar salida de progreso
  const progressInterval = setInterval(() => {
    if (queueItem.status === 'ready' || queueItem.status === 'error') {
      clearInterval(progressInterval);
      return;
    }
  }, 500);

  if (child.stdout) {
    child.stdout.on('data', (data) => {
      const output = data.toString();
      // Buscar líneas que comienzan con [download] y contienen progreso
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('[download]') && line.includes('%')) {
          // Extraer solo si está entre 0 y 99, excluir 100% inicial
          const percentMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)\s*%/);
          if (percentMatch) {
            const progress = parseFloat(percentMatch[1]);
            // Solo actualizar si es un progreso válido (0-99, excluyendo mensajes de inicio)
            if (progress >= 0 && progress < 100) {
              queueItem.progress = progress;
              const jam = jams.get(jamId);
              if (jam) io.to(jamId).emit('jam-state', getPublicJamState(jam));
            }
          }
        }
      }
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (data) => {
      const output = data.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('[download]') && line.includes('%')) {
          const percentMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)\s*%/);
          if (percentMatch) {
            const progress = parseFloat(percentMatch[1]);
            if (progress >= 0 && progress < 100) {
              queueItem.progress = progress;
              const jam = jams.get(jamId);
              if (jam) io.to(jamId).emit('jam-state', getPublicJamState(jam));
            }
          }
        }
      }
    });
  }
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

app.get('/api/playlist', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  
  try {
    // Extract playlist ID from URL
    let playlistId = null;
    
    // Try different playlist URL patterns
    const patterns = [
      /list=([a-zA-Z0-9_-]+)/,  // ?list=ID or &list=ID
      /\/playlist\?list=([a-zA-Z0-9_-]+)/,
      /playlist\/([a-zA-Z0-9_-]+)/,
      /^([a-zA-Z0-9_-]+)$/, // Just the ID
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        playlistId = match[1];
        break;
      }
    }
    
    if (!playlistId) {
      return res.status(400).json({ error: 'URL de playlist inválida' });
    }
    
    console.log('[Playlist] Loading playlist ID:', playlistId);
    const playlist = await YouTube.getPlaylist(`https://www.youtube.com/playlist?list=${playlistId}`);
    
    if (!playlist) return res.status(400).json({ error: 'Playlist no encontrada' });
    
    // Get videos - playlist.fetch() returns the playlist object, not just videos
    let videos = [];
    if (Array.isArray(playlist.videos)) {
      videos = playlist.videos;
    } else if (Array.isArray(playlist)) {
      videos = playlist;
    } else if (playlist.all && Array.isArray(playlist.all())) {
      videos = await playlist.all();
    } else if (typeof playlist.fetch === 'function') {
      const fetched = await playlist.fetch();
      videos = Array.isArray(fetched) ? fetched : (Array.isArray(fetched.videos) ? fetched.videos : []);
    }
    
    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'No se encontraron videos en la playlist' });
    }
    
    const limit = Math.min(videos.length, 50); // Limitar a 50 videos
    
    const results = videos.slice(0, limit).map(v => ({
      videoId: v.id,
      title: v.title,
      thumbnail: v.thumbnail?.url || ('https://img.youtube.com/vi/' + v.id + '/mqdefault.jpg'),
      duration: v.durationFormatted || '',
      channel: v.channel?.name || '',
      cached: fs.existsSync(path.join(mediaDir, `${v.id}.mp4`)),
    }));
    
    res.json({
      name: playlist.name,
      videoCount: videos.length,
      videos: results,
    });
  } catch (err) {
    console.error('Playlist error:', err.message);
    console.error('Stack:', err.stack);
    res.status(400).json({ error: 'No se pudo obtener la playlist: ' + err.message });
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
      status: 'pending',
      mediaUrl: null,
    };

    if (existing) {
      queueItem.status = 'ready';
      queueItem.mediaUrl = existing.mediaUrl;
    }

    jam.queue.push(queueItem);
    io.to(currentJamId).emit('jam-state', getPublicJamState(jam));

    if (queueItem.status !== 'ready') {
      // Encolar para descarga en lugar de descargar directamente
      jam.pendingDownloads.push({ videoId: sanitizedVideoId, queueItem });
      startNextDownload(currentJamId);
    }
  });

  // --- Admin-only operations ---

  function isAdmin() {
    return socket.role === 'admin';
  }

  socket.on('add-playlist', ({ videos, playlistName }) => {
    if (!isAdmin()) return;
    const jam = jams.get(currentJamId);
    if (!jam) return;

    if (!Array.isArray(videos) || videos.length === 0) return;

    let addedCount = 0;
    for (const video of videos) {
      const sanitizedVideoId = String(video.videoId).substring(0, 20);
      
      // Check if video already exists in queue
      const existing = jam.queue.find(v => v.videoId === sanitizedVideoId);
      if (existing) continue;

      const existing2 = jam.queue.find(v => v.videoId === sanitizedVideoId && v.status === 'ready');

      const queueItem = {
        id: nanoid(6),
        videoId: sanitizedVideoId,
        title: String(video.title).substring(0, 200),
        thumbnail: String(video.thumbnail).substring(0, 300),
        addedBy: `Playlist: ${String(playlistName).substring(0, 30)}`,
        status: 'pending',
        mediaUrl: null,
      };

      if (existing2) {
        queueItem.status = 'ready';
        queueItem.mediaUrl = existing2.mediaUrl;
      }

      jam.queue.push(queueItem);
      addedCount++;

      if (queueItem.status !== 'ready') {
        // Encolar para descarga
        jam.pendingDownloads.push({ videoId: sanitizedVideoId, queueItem });
      }
    }

    io.to(currentJamId).emit('jam-state', getPublicJamState(jam));
    socket.emit('playlist-added', { count: addedCount, total: videos.length });
    
    // Iniciar descargas
    startNextDownload(currentJamId);
  });

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
