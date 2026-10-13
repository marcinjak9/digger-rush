// Stable colour per nickname: hash to a hue.
export function nickColor(nick: string): string {
  let h = 2166136261;
  for (let i = 0; i < nick.length; i++) h = Math.imul(h ^ nick.charCodeAt(i), 16777619);
  const hue = (h >>> 0) % 360;
  return `hsl(${hue}, 75%, 62%)`;
}
