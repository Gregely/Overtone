const paths = {
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  next: 'M6 6.5v11a1 1 0 0 0 1.5.86L15 13.6V18h2V6h-2v4.4L7.5 5.64A1 1 0 0 0 6 6.5z',
  prev: 'M18 6.5v11a1 1 0 0 1-1.5.86L9 13.6V18H7V6h2v4.4l7.5-4.76A1 1 0 0 1 18 6.5z',
  shuffle: 'M16 4h4v4M4 20l16-16M20 16v4h-4M14.5 14.5 20 20M4 4l5 5',
  repeat: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  library: 'M4 4h3v16H4zM10 4h3v16h-3zM15.5 4.6l2.9-.8 4.1 15.4-2.9.8z',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  queue: 'M4 6h12M4 12h12M4 18h8M18 15v6l4-3z',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  album: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  back: 'M15 5l-7 7 7 7',
  volume: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  wifiOff: 'M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.4M19 12.5a10 10 0 0 0-2.7-1.9M2 8.8A15 15 0 0 1 6 6.3M22 8.8a15 15 0 0 0-10-3.8M12 20h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  wand: 'M15 4V2M15 10V8M12 5h-2M20 5h-2M17.8 7.8l1.4 1.4M17.8 2.2l1.4-1.4M3 21l12-12',
  bars: 'M6 14v-4M10 18V6M14 20V4M18 16V8',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  phone: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
} as const;

export type IconName = keyof typeof paths;
const filled = new Set<IconName>(['play', 'pause', 'next', 'prev', 'home', 'library']);

/** Decorative icon. Give the surrounding control an accessible name. */
export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const fill = filled.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
