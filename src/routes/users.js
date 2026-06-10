import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { db, avatarsDir } from '../db.js';
import { authMiddleware } from '../auth.js';
import {
  publicUser,
  validateUsername,
  sanitizeBio,
  emitUserUpdated,
  USERNAME_CHANGE_COOLDOWN,
} from '../utils/user.js';
import { getBlockStatus } from '../utils/blocks.js';
import { verifyToken } from '../auth.js';
import { getOnlineUsers } from '../socket.js';

const router = Router();

function getOptionalUserId(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyToken(header.slice(7));
  return payload?.userId ?? null;
}

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: avatarsDir,
    filename: (req, _file, cb) => cb(null, `${req.userId}.webp`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, GIF, WEBP allowed'), ok);
  },
});

router.get('/check-username', (req, res) => {
  const username = (req.query.username || '').toLowerCase().trim();
  const err = validateUsername(username);
  if (err) return res.json({ available: false, error: err });

  const userId = getOptionalUserId(req) || '';
  const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId);
  res.json({ available: !existing, username });
});

router.use(authMiddleware);

router.get('/me', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
});

router.put('/profile', (req, res) => {
  const { displayName, bio } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const cleanBio = bio !== undefined ? sanitizeBio(bio) : user.bio;
  const name = displayName !== undefined ? String(displayName).trim().slice(0, 50) || user.display_name : user.display_name;

  db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(name, cleanBio, req.userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  emitUserUpdated(req.app.locals.io, updated);
  res.json(publicUser(updated));
});

router.patch('/me', (req, res) => {
  const { displayName, bio } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const cleanBio = bio !== undefined ? sanitizeBio(bio) : user.bio;
  const name = displayName ?? user.display_name;

  db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(name, cleanBio, req.userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  emitUserUpdated(req.app.locals.io, updated);
  res.json(publicUser(updated));
});

router.patch('/me/username', (req, res) => {
  const { username } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const u = (username || '').toLowerCase().trim();
  const err = validateUsername(u);
  if (err) return res.status(400).json({ error: err });

  if (u === user.username) return res.json(publicUser(user));

  if (user.username_updated_at) {
    const elapsed = Date.now() - user.username_updated_at;
    if (elapsed < USERNAME_CHANGE_COOLDOWN) {
      const daysLeft = Math.ceil((USERNAME_CHANGE_COOLDOWN - elapsed) / (24 * 60 * 60 * 1000));
      return res.status(429).json({ error: `Username can be changed again in ${daysLeft} days` });
    }
  }

  const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(u, req.userId);
  if (taken) return res.status(409).json({ error: 'Username already taken' });

  const now = Date.now();
  db.prepare('UPDATE users SET username = ?, username_updated_at = ? WHERE id = ?').run(u, now, req.userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  emitUserUpdated(req.app.locals.io, updated);
  res.json(publicUser(updated));
});

router.post('/me/avatar', (req, res, next) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const now = Date.now();
  const avatarUrl = `/avatars/${req.userId}.webp?v=${now}`;
  db.prepare('UPDATE users SET avatar = ?, last_avatar_update = ? WHERE id = ?').run(avatarUrl, now, req.userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  req.app.locals.io?.emit('user:avatar_update', { userId: req.userId, avatar: avatarUrl });
  emitUserUpdated(req.app.locals.io, updated);
  res.json(publicUser(updated));
});

router.delete('/me/avatar', (req, res) => {
  const filePath = path.join(avatarsDir, `${req.userId}.webp`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('UPDATE users SET avatar = NULL, last_avatar_update = ? WHERE id = ?').run(Date.now(), req.userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  req.app.locals.io?.emit('user:avatar_update', { userId: req.userId, avatar: null });
  emitUserUpdated(req.app.locals.io, updated);
  res.json(publicUser(updated));
});

router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  const users = db.prepare(`
    SELECT u.* FROM users u
    WHERE u.id != ?
      AND (u.username LIKE ? OR u.display_name LIKE ?)
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks b
        WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
           OR (b.blocker_id = u.id AND b.blocked_id = ?)
      )
    LIMIT 20
  `).all(req.userId, `%${q}%`, `%${q}%`, req.userId, req.userId);

  res.json(users.map(u => publicUser(u)));
});

router.get('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const block = getBlockStatus(req.userId, user.id);
  const online = getOnlineUsers().includes(user.id);

  res.json(publicUser(user, {
    online,
    ...block,
  }));
});

router.post('/:id/block', (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: 'Cannot block yourself' });

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const exists = db.prepare(
    'SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'
  ).get(req.userId, targetId);

  if (!exists) {
    db.prepare('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
      .run(req.userId, targetId, Date.now());
  }

  res.json({ ok: true, iBlocked: true });
});

router.delete('/:id/block', (req, res) => {
  db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?')
    .run(req.userId, req.params.id);
  res.json({ ok: true, iBlocked: false });
});

export default router;
