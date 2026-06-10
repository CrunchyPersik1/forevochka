import { db } from '../db.js';

export function isBlocked(userIdA, userIdB) {
  if (!userIdA || !userIdB) return false;
  const row = db.prepare(`
    SELECT 1 FROM user_blocks
    WHERE (blocker_id = ? AND blocked_id = ?)
       OR (blocker_id = ? AND blocked_id = ?)
  `).get(userIdA, userIdB, userIdB, userIdA);
  return !!row;
}

export function isBlockedBy(blockerId, blockedId) {
  return !!db.prepare(
    'SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'
  ).get(blockerId, blockedId);
}

export function getBlockStatus(viewerId, targetId) {
  const iBlocked = !!db.prepare(
    'SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'
  ).get(viewerId, targetId);
  const blockedMe = !!db.prepare(
    'SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'
  ).get(targetId, viewerId);
  return { iBlocked, blockedMe, isBlocked: iBlocked || blockedMe };
}
