import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { signToken } from '../auth.js';
import { publicUser, validateUsername } from '../utils/user.js';

const router = Router();

router.post('/register', (req, res) => {
  const { username, email, password, displayName } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password required' });
  }

  const u = username.toLowerCase().trim();
  const usernameErr = validateUsername(u);
  if (usernameErr) return res.status(400).json({ error: usernameErr });

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(u, email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Username or email already taken' });

  const id = uuid();
  const now = Date.now();
  const hash = bcrypt.hashSync(password, 10);

  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, u, email.toLowerCase(), hash, displayName || u, now);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = signToken(id);
  res.json({ token, user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'Login and password required' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? OR email = ?'
  ).get(login.toLowerCase(), login.toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken(user.id);
  res.json({ token, user: publicUser(user) });
});

export default router;
