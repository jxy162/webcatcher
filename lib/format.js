export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function shortUrl(url, max = 54) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const label = `${parsed.host}${path}`;
    return label.length > max ? `${label.slice(0, max - 1)}…` : label;
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url;
  }
}

export function formatClock(ms) {
  if (!Number.isFinite(ms)) return '0:00.0';
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${tenths}`;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 1000) return '刚刚';
  if (delta < 60000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
  return `${Math.floor(delta / 3600000)} 小时前`;
}
