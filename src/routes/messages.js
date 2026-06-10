import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { uploadsDir } from '../db.js';
import { authMiddleware } from '../auth.js';
import { isMember, formatMessage, getChatMembers } from './chats.js';
import { isBlocked } from '../utils/blocks.js';
import { db } from '../db.js';

const router = Router();
router.use(authMiddleware);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/:chatId', upload.array('files', 10), (req, res) => {
  const { chatId } = req.params;
  const { content, type, replyToId } = req.body;

  if (!isMember(chatId, req.userId)) return res.status(403).json({ error: 'Not a member' });

  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId);
  if (chat?.type === 'direct') {
    const members = getChatMembers(chatId);
    const other = members.find(m => m.id !== req.userId);
    if (other && isBlocked(req.userId, other.id)) {
      return res.status(403).json({ error: 'Cannot message this user' });
    }
  }

  const msgType = type || (req.files?.length ? guessType(req.files[0].mimetype) : 'text');
  if (msgType === 'text' && !content?.trim() && !req.files?.length) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  const msgId = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO messages (id, chat_id, sender_id, content, type, reply_to_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(msgId, chatId, req.userId, content?.trim() || null, msgType, replyToId || null, now);

  if (req.files?.length) {
    const insert = db.prepare(
      'INSERT INTO attachments (id, message_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const f of req.files) {
      insert.run(uuid(), msgId, f.filename, f.originalname, f.mimetype, f.size);
    }
  }

  const row = db.prepare(`
    SELECT m.*, u.display_name as sender_name, u.avatar as sender_avatar FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
  `).get(msgId);

  const message = formatMessage(row);
  req.app.locals.io?.to(`chat:${chatId}`).emit('message:new', message);
  res.status(201).json(message);
});

router.patch('/:id', (req, res) => {
  const { content } = req.body;
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.sender_id !== req.userId) return res.status(403).json({ error: 'Not your message' });
  if (msg.type !== 'text') return res.status(400).json({ error: 'Can only edit text messages' });

  const now = Date.now();
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, now, msg.id);

  const row = db.prepare(`
    SELECT m.*, u.display_name as sender_name, u.avatar as sender_avatar FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
  `).get(msg.id);

  const message = formatMessage(row);
  req.app.locals.io?.to(`chat:${msg.chat_id}`).emit('message:updated', message);
  res.json(message);
});

router.delete('/:id', (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.sender_id !== req.userId) return res.status(403).json({ error: 'Not your message' });

  const now = Date.now();
  db.prepare('UPDATE messages SET deleted_at = ?, content = NULL WHERE id = ?').run(now, msg.id);

  const row = db.prepare(`
    SELECT m.*, u.display_name as sender_name, u.avatar as sender_avatar FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
  `).get(msg.id);

  const message = formatMessage(row);
  req.app.locals.io?.to(`chat:${msg.chat_id}`).emit('message:updated', message);
  res.json(message);
});

router.post('/:id/reactions', (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'emoji required' });

  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!isMember(msg.chat_id, req.userId)) return res.status(403).json({ error: 'Not a member' });

  const existing = db.prepare(
    'SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
  ).get(msg.id, req.userId, emoji);

  if (existing) {
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(msg.id, req.userId, emoji);
  } else {
    db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
      .run(msg.id, req.userId, emoji, Date.now());
  }

  const reactions = db.prepare('SELECT emoji, user_id FROM message_reactions WHERE message_id = ?').all(msg.id);
  const reactionMap = {};
  for (const r of reactions) {
    if (!reactionMap[r.emoji]) reactionMap[r.emoji] = [];
    reactionMap[r.emoji].push(r.user_id);
  }

  const payload = { messageId: msg.id, chatId: msg.chat_id, reactions: reactionMap };
  req.app.locals.io?.to(`chat:${msg.chat_id}`).emit('message:reaction', payload);
  res.json(payload);
});

router.post('/read/:chatId', (req, res) => {
  const { chatId } = req.params;
  const { messageId } = req.body;

  if (!isMember(chatId, req.userId)) return res.status(403).json({ error: 'Not a member' });

  db.prepare(
    'UPDATE chat_members SET last_read_message_id = ? WHERE chat_id = ? AND user_id = ?'
  ).run(messageId, chatId, req.userId);

  req.app.locals.io?.to(`chat:${chatId}`).emit('message:read', {
    chatId,
    userId: req.userId,
    messageId,
    readAt: Date.now(),
  });

  res.json({ ok: true });
});

function guessType(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'voice';
  return 'file';
}

export default router;
