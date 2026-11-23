export function GolfFlagIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-label="Meadow Gardens golf flag"
    >
      {/* Pole */}
      <line x1="12" y1="3" x2="12" y2="21" />
      {/* Flag */}
      <path d="M12 3 L20 7 L12 11 Z" fill="currentColor" stroke="none" />
      {/* Ground circle */}
      <ellipse cx="12" cy="21" rx="4" ry="1.5" />
    </svg>
  );
}
