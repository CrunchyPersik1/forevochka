import { db } from '../db.js';

export function isGroupCreator(chatId, userId) {
  const chat = db.prepare('SELECT created_by FROM chats WHERE id = ?').get(chatId);
  return chat?.created_by === userId;
}

export function isGroupAdmin(chatId, userId) {
  if (isGroupCreator(chatId, userId)) return true;
  const row = db.prepare(
    'SELECT 1 FROM group_admins WHERE chat_id = ? AND user_id = ?'
  ).get(chatId, userId);
  return !!row;
}

export function getGroupAdmins(chatId) {
  const chat = db.prepare('SELECT created_by FROM chats WHERE id = ?').get(chatId);
  const admins = db.prepare('SELECT user_id FROM group_admins WHERE chat_id = ?').all(chatId);
  const ids = new Set(admins.map(a => a.user_id));
  if (chat?.created_by) ids.add(chat.created_by);
  return [...ids];
}
