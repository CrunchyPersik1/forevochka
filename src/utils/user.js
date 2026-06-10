export const USERNAME_REGEX = /^[a-z0-9._]{3,20}$/;
export const BIO_MAX_LENGTH = 150;
export const USERNAME_CHANGE_COOLDOWN = 30 * 24 * 60 * 60 * 1000;

export function validateUsername(username) {
  if (!username || typeof username !== 'string') return 'Username required';
  const u = username.toLowerCase().trim();
  if (!USERNAME_REGEX.test(u)) {
    return 'Username: 3–20 chars, latin letters, digits, dot, underscore only';
  }
  return null;
}

export function sanitizeBio(bio) {
  if (!bio) return '';
  return String(bio)
    .replace(/<[^>]*>/g, '')
    .slice(0, BIO_MAX_LENGTH);
}

export function publicUser(row, extras = {}) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
    bio: row.bio || '',
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    usernameUpdatedAt: row.username_updated_at ?? null,
    ...extras,
  };
}

export function emitUserUpdated(io, userRow) {
  if (!io || !userRow) return;
  io.emit('user:updated', publicUser(userRow));
}
