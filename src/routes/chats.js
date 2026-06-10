import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { db, groupAvatarsDir } from '../db.js';
import { authMiddleware } from '../auth.js';
import { isBlocked } from '../utils/blocks.js';
import { isGroupAdmin, isGroupCreator, getGroupAdmins } from '../utils/groups.js';

const router = Router();
router.use(authMiddleware);

const groupAvatarUpload = multer({
  storage: multer.diskStorage({
    destination: groupAvatarsDir,
    filename: (req, _file, cb) => cb(null, `${req.params.id}.webp`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, GIF, WEBP allowed'), ok);
  },
});

function getClearedAt(chatId, userId) {
  const row = db.prepare(
    'SELECT cleared_at FROM chat_members WHERE chat_id = ? AND user_id = ?'
  ).get(chatId, userId);
  return row?.cleared_at || 0;
}

function getChatMembers(chatId) {
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.bio, u.last_seen, u.created_at, cm.role, cm.joined_at
    FROM chat_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = ?
    ORDER BY cm.joined_at ASC
  `).all(chatId).map(m => ({
    id: m.id,
    username: m.username,
    displayName: m.display_name,
    avatar: m.avatar,
    bio: m.bio,
    lastSeen: m.last_seen,
    createdAt: m.created_at,
    role: m.role,
    joinedAt: m.joined_at,
  }));
}

function getLastMessage(chatId, userId) {
  const clearedAt = getClearedAt(chatId, userId);
  const msg = db.prepare(`
    SELECT m.*, u.display_name as sender_name, u.avatar as sender_avatar
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? AND m.deleted_at IS NULL AND m.created_at > ?
    ORDER BY m.created_at DESC LIMIT 1
  `).get(chatId, clearedAt);
  if (!msg) return null;
  return formatMessage(msg);
}

function getUnreadCount(chatId, userId) {
  const member = db.prepare(
    'SELECT last_read_message_id, cleared_at FROM chat_members WHERE chat_id = ? AND user_id = ?'
  ).get(chatId, userId);

  let lastReadTime = member?.cleared_at || 0;
  if (member?.last_read_message_id) {
    const lastRead = db.prepare('SELECT created_at FROM messages WHERE id = ?').get(member.last_read_message_id);
    if (lastRead && lastRead.created_at > lastReadTime) lastReadTime = lastRead.created_at;
  }

  const row = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE chat_id = ? AND sender_id != ? AND created_at > ? AND deleted_at IS NULL AND type != 'system'
  `).get(chatId, userId, lastReadTime);

  return row.count;
}

function formatMessage(row) {
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(row.id);
  const reactions = db.prepare(`
    SELECT emoji, user_id FROM message_reactions WHERE message_id = ?
  `).all(row.id);

  const reactionMap = {};
  for (const r of reactions) {
    if (!reactionMap[r.emoji]) reactionMap[r.emoji] = [];
    reactionMap[r.emoji].push(r.user_id);
  }

  let replyTo = null;
  if (row.reply_to_id) {
    const reply = db.prepare(`
      SELECT m.*, u.display_name as sender_name, u.avatar as sender_avatar FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
    `).get(row.reply_to_id);
    if (reply) replyTo = formatMessage(reply);
  }

  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderAvatar: row.sender_avatar,
    content: row.deleted_at ? null : row.content,
    type: row.type,
    replyToId: row.reply_to_id,
    replyTo,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    attachments: attachments.map(a => ({
      id: a.id,
      filename: a.filename,
      originalName: a.original_name,
      mimeType: a.mime_type,
      size: a.size,
      url: `/uploads/${a.filename}`,
    })),
    reactions: reactionMap,
  };
}

function formatChat(chat, userId) {
  const members = getChatMembers(chat.id);
  let name = chat.name;
  let avatar = chat.avatar;

  if (chat.type === 'direct') {
    const other = members.find(m => m.id !== userId);
    if (other) {
      name = other.displayName;
      avatar = other.avatar;
    }
  }

  const admins = chat.type === 'group' ? getGroupAdmins(chat.id) : [];

  return {
    id: chat.id,
    type: chat.type,
    name,
    avatar,
    groupName: chat.name,
    groupAvatar: chat.avatar,
    createdBy: chat.created_by,
    admins,
    members,
    lastMessage: getLastMessage(chat.id, userId),
    unreadCount: getUnreadCount(chat.id, userId),
    createdAt: chat.created_at,
    isAdmin: chat.type === 'group' ? isGroupAdmin(chat.id, userId) : false,
    isCreator: chat.type === 'group' ? isGroupCreator(chat.id, userId) : false,
  };
}

function isMember(chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}

function shouldHideDirectChat(chat, userId) {
  if (chat.type !== 'direct') return false;
  const members = getChatMembers(chat.id);
  const other = members.find(m => m.id !== userId);
  return other ? isBlocked(userId, other.id) : false;
}

function emitSystemMessage(io, chatId, content) {
  const sysId = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO messages (id, chat_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)').run(
    sysId, chatId, content, 'system', now
  );
  const row = db.prepare(`
    SELECT m.*, u.display_name as sender_name, u.avatar as sender_avatar FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
  `).get(sysId);
  const message = formatMessage(row);
  io?.to(`chat:${chatId}`).emit('message:new', message);
  return message;
}

router.get('/', (req, res) => {
  const chats = db.prepare(`
    SELECT c.* FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.userId);

  const formatted = chats
    .map(c => formatChat(c, req.userId))
    .filter(c => !shouldHideDirectChat(
      db.prepare('SELECT * FROM chats WHERE id = ?').get(c.id),
      req.userId
    ));

  formatted.sort((a, b) => {
    const aTime = a.lastMessage?.createdAt || a.createdAt;
    const bTime = b.lastMessage?.createdAt || b.createdAt;
    return bTime - aTime;
  });

  res.json(formatted);
});

router.post('/direct', (req, res) => {
  const { userId: otherUserId } = req.body;
  if (!otherUserId) return res.status(400).json({ error: 'userId required' });
  if (otherUserId === req.userId) return res.status(400).json({ error: 'Cannot chat with yourself' });

  if (isBlocked(req.userId, otherUserId)) {
    return res.status(403).json({ error: 'Cannot message this user' });
  }

  const other = db.prepare('SELECT id FROM users WHERE id = ?').get(otherUserId);
  if (!other) return res.status(404).json({ error: 'User not found' });

  const existing = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
    JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
    WHERE c.type = 'direct'
  `).get(req.userId, otherUserId);

  if (existing) {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(existing.id);
    return res.json(formatChat(chat, req.userId));
  }

  const chatId = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO chats (id, type, created_by, created_at) VALUES (?, ?, ?, ?)').run(chatId, 'direct', req.userId, now);
  db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(chatId, req.userId, 'member', now);
  db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(chatId, otherUserId, 'member', now);

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  const formatted = formatChat(chat, req.userId);

  req.app.locals.io?.to(`user:${req.userId}`).emit('chat:new', formatted);
  req.app.locals.io?.to(`user:${otherUserId}`).emit('chat:new', formatChat(chat, otherUserId));

  res.status(201).json(formatted);
});

router.post('/group', (req, res) => {
  const { name, memberIds } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Group name required' });

  const members = [...new Set([req.userId, ...(memberIds || [])])];
  const chatId = uuid();
  const now = Date.now();

  db.prepare('INSERT INTO chats (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(
    chatId, 'group', name.trim(), req.userId, now
  );

  const insertMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
  for (const uid of members) {
    insertMember.run(chatId, uid, uid === req.userId ? 'admin' : 'member', now);
  }

  db.prepare('INSERT INTO group_admins (chat_id, user_id, created_at) VALUES (?, ?, ?)').run(chatId, req.userId, now);

  const groupName = name.trim();
  const chatRow = () => db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);

  for (const uid of members) {
    if (uid === req.userId) continue;
    req.app.locals.io?.to(`user:${uid}`).emit('chat:new', formatChat(chatRow(), uid));
    getSocketJoin(uid, chatId, req.app.locals.io);
  }

  emitSystemMessage(req.app.locals.io, chatId, `Группа "${groupName}" создана`);

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  res.status(201).json(formatChat(chat, req.userId));
});

function getSocketJoin(userId, chatId, io) {
  const sockets = io?.sockets?.sockets;
  if (!sockets) return;
  for (const [, socket] of sockets) {
    if (socket.userId === userId) socket.join(`chat:${chatId}`);
  }
}

router.get('/:id', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isMember(chat.id, req.userId)) return res.status(403).json({ error: 'Not a member' });
  res.json(formatChat(chat, req.userId));
});

router.get('/:id/messages', (req, res) => {
  const { id } = req.params;
  if (!isMember(id, req.userId)) return res.status(403).json({ error: 'Not a member' });

  const clearedAt = getClearedAt(id, req.userId);
  const before = parseInt(req.query.before) || Date.now() + 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);

  const messages = db.prepare(`
    SELECT m.*, u.display_name as sender_name, u.avatar as sender_avatar
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? AND m.created_at < ? AND m.created_at > ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(id, before, clearedAt, limit);

  res.json(messages.reverse().map(formatMessage));
});

router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Not a group chat' });
  if (!isGroupAdmin(id, req.userId)) return res.status(403).json({ error: 'Only admins can edit group' });

  if (name?.trim()) {
    db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(name.trim(), id);
    const myName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId).display_name;
    emitSystemMessage(req.app.locals.io, id, `${myName} изменил(а) название группы на "${name.trim()}"`);
  }

  const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  const payload = formatChat(updated, req.userId);
  req.app.locals.io?.to(`chat:${id}`).emit('chat:updated', payload);
  res.json(payload);
});

router.post('/:id/avatar', groupAvatarUpload.single('avatar'), (req, res) => {
  const { id } = req.params;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Not a group chat' });
  if (!isGroupAdmin(id, req.userId)) return res.status(403).json({ error: 'Only admins can edit group' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const now = Date.now();
  const avatarUrl = `/avatars/groups/${id}.webp?v=${now}`;
  db.prepare('UPDATE chats SET avatar = ? WHERE id = ?').run(avatarUrl, id);

  const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  const payload = formatChat(updated, req.userId);
  req.app.locals.io?.to(`chat:${id}`).emit('chat:updated', payload);
  res.json(payload);
});

router.delete('/:id/avatar', (req, res) => {
  const { id } = req.params;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Not a group chat' });
  if (!isGroupAdmin(id, req.userId)) return res.status(403).json({ error: 'Only admins can edit group' });

  const filePath = path.join(groupAvatarsDir, `${id}.webp`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('UPDATE chats SET avatar = NULL WHERE id = ?').run(id);

  const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  const payload = formatChat(updated, req.userId);
  req.app.locals.io?.to(`chat:${id}`).emit('chat:updated', payload);
  res.json(payload);
});

router.post('/:id/members', (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Not a group chat' });
  if (!isGroupAdmin(id, req.userId)) return res.status(403).json({ error: 'Only admins can add members' });

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const exists = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(id, userId);
  if (exists) return res.status(409).json({ error: 'Already a member' });

  const now = Date.now();
  db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, userId, 'member', now);

  const myName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId).display_name;
  emitSystemMessage(req.app.locals.io, id, `${myName} добавил(а) ${user.display_name}`);

  getSocketJoin(userId, id, req.app.locals.io);
  req.app.locals.io?.to(`user:${userId}`).emit('chat:new', formatChat(chat, userId));

  res.json({ ok: true, chat: formatChat(chat, req.userId) });
});

router.delete('/:id/members/:userId', (req, res) => {
  const { id, userId } = req.params;

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Not a group chat' });
  if (!isGroupAdmin(id, req.userId)) return res.status(403).json({ error: 'Only admins can remove members' });
  if (userId === req.userId) return res.status(400).json({ error: 'Use leave endpoint to exit group' });
  if (userId === chat.created_by) return res.status(400).json({ error: 'Cannot remove group creator' });

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(id, userId);
  db.prepare('DELETE FROM group_admins WHERE chat_id = ? AND user_id = ?').run(id, userId);

  const myName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId).display_name;
  emitSystemMessage(req.app.locals.io, id, `${myName} удалил(а) ${user.display_name}`);

  req.app.locals.io?.to(`user:${userId}`).emit('chat:removed', { chatId: id });

  res.json({ ok: true });
});

router.post('/:id/admins', (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Not a group chat' });
  if (!isGroupCreator(id, req.userId)) return res.status(403).json({ error: 'Only creator can assign admins' });

  if (!isMember(id, userId)) return res.status(400).json({ error: 'User is not a member' });

  const exists = db.prepare('SELECT 1 FROM group_admins WHERE chat_id = ? AND user_id = ?').get(id, userId);
  if (!exists) {
    db.prepare('INSERT INTO group_admins (chat_id, user_id, created_at) VALUES (?, ?, ?)').run(id, userId, Date.now());
    const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
    emitSystemMessage(req.app.locals.io, id, `${user.display_name} назначен(а) администратором`);
  }

  res.json({ ok: true, chat: formatChat(chat, req.userId) });
});

router.post('/:id/leave', (req, res) => {
  const { id } = req.params;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Not a group chat' });
  if (!isMember(id, req.userId)) return res.status(403).json({ error: 'Not a member' });

  const myName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId).display_name;

  if (chat.created_by === req.userId) {
    const nextAdmin = db.prepare(`
      SELECT user_id FROM chat_members
      WHERE chat_id = ? AND user_id != ?
      ORDER BY joined_at ASC LIMIT 1
    `).get(id, req.userId);

    if (nextAdmin) {
      db.prepare('UPDATE chats SET created_by = ? WHERE id = ?').run(nextAdmin.user_id, id);
      db.prepare('INSERT OR IGNORE INTO group_admins (chat_id, user_id, created_at) VALUES (?, ?, ?)')
        .run(id, nextAdmin.user_id, Date.now());
      const nextName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(nextAdmin.user_id).display_name;
      emitSystemMessage(req.app.locals.io, id, `${nextName} назначен(а) новым создателем группы`);
    }
  }

  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(id, req.userId);
  db.prepare('DELETE FROM group_admins WHERE chat_id = ? AND user_id = ?').run(id, req.userId);

  emitSystemMessage(req.app.locals.io, id, `${myName} вышел(а) из группы`);
  req.app.locals.io?.to(`user:${req.userId}`).emit('chat:removed', { chatId: id });

  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Not a group chat' });
  if (!isGroupAdmin(id, req.userId)) return res.status(403).json({ error: 'Only admins can delete group' });

  const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(id);

  db.prepare('DELETE FROM chats WHERE id = ?').run(id);

  const avatarPath = path.join(groupAvatarsDir, `${id}.webp`);
  if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath);

  for (const { user_id } of members) {
    req.app.locals.io?.to(`user:${user_id}`).emit('chat:removed', { chatId: id });
  }

  res.json({ ok: true });
});

router.delete('/:id/history', (req, res) => {
  const { id } = req.params;
  if (!isMember(id, req.userId)) return res.status(403).json({ error: 'Not a member' });

  const now = Date.now();
  db.prepare('UPDATE chat_members SET cleared_at = ?, last_read_message_id = NULL WHERE chat_id = ? AND user_id = ?')
    .run(now, id, req.userId);

  res.json({ ok: true, clearedAt: now });
});

export { formatMessage, formatChat, isMember, getChatMembers };
export default router;
