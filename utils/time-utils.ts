export function formatDuration(seconds: number): string {
  seconds = Math.max(0, Math.round(Number(seconds)));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  let result = '';
  if (days) result += `${days}d `;
  if (hours) result += `${hours}h `;
  if (minutes) result += `${minutes}m `;
  result += `${seconds}s`;
  return result.trim();
} 