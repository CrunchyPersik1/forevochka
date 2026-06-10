import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { uploadsDir, avatarsDir, groupAvatarsDir } from './db.js';
import { setupSocket, getOnlineUsers } from './socket.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import chatRoutes from './routes/chats.js';
import messageRoutes from './routes/messages.js';
import { authMiddleware } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] },
});

app.locals.io = io;
setupSocket(io);

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use('/avatars/groups', express.static(groupAvatarsDir));
app.use('/avatars', express.static(avatarsDir));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);

app.get('/api/online', authMiddleware, (_req, res) => {
  res.json(getOnlineUsers());
});

const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/avatars')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).send('Client not built. Run: npm run dev');
  });
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

httpServer.listen(PORT, HOST, () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         MESSSENGER is running!           ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${PORT}           ║`);
  console.log(`  ║  Network: http://${ip}:${PORT}`.padEnd(43) + '║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║  Open Network URL on second device       ║');
  console.log('  ║  (same Wi-Fi required)                   ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
