export function getInitials(name?: string | null) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
}

export function getHue(seed?: string | null) {
  let hash = 0;
  for (const char of seed || '') hash = char.charCodeAt(0) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

export function timeAgo(value?: string | Date | null) {
  if (!value) return 'agora';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return 'agora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}
