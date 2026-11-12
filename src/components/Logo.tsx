import { useEffect, useMemo, useState, type CSSProperties } from 'react';

/*
 * The OTS logo, drawn rather than typed.
 *
 *  O — a ring with a trapezoid slice cut out of the bottom.
 *  T — the bottom-left corner of the stem is sliced off and nudged outwards.
 *  S — the tip of the top terminal is sliced off and nudged outwards.
 *
 * Everything sits on a 100-unit cap height with 22-unit strokes.
 */

const rad = (deg: number) => (deg * Math.PI) / 180;
const point = (cx: number, cy: number, r: number, deg: number) => `${(cx + r * Math.cos(rad(deg))).toFixed(2)} ${(cy + r * Math.sin(rad(deg))).toFixed(2)}`;

/** A piece of a ring between two angles (degrees, clockwise, 0 = 3 o'clock). */
function ringPiece(cx: number, cy: number, outer: number, inner: number, from: number, to: number): string {
  const large = to - from > 180 ? 1 : 0;
  return `M${point(cx, cy, outer, from)}A${outer} ${outer} 0 ${large} 1 ${point(cx, cy, outer, to)}L${point(cx, cy, inner, to)}A${inner} ${inner} 0 ${large} 0 ${point(cx, cy, inner, from)}Z`;
}

const OUTER = 50;
const INNER = 28;
// The slice missing from the bottom spans 40°, centred on 6 o'clock (90°).
const RING_FROM = 110;
const RING_TO = 430;

const O_PATH = ringPiece(50, 50, OUTER, INNER, RING_FROM, RING_TO);

// For the opening animation the same ring is cut into five uneven pieces.
// Each overlaps the next by half a degree so no hairline shows once they meet.
const CUTS = [RING_FROM, 172, 238, 297, 365, RING_TO];
const O_PIECES = CUTS.slice(0, -1).map((from, i) => ringPiece(50, 50, OUTER, INNER, from, CUTS[i + 1] + (i < 4 ? 0.5 : 0)));

// T: bar 112–192, stem 141–163, with the stem's foot cut on a diagonal.
const T_PATH = 'M112 0H192V22H163V100L141 72V22H112Z';
const T_BIT = 'M134 79L156 107H134Z';

// S: two stacked arcs. The last 26° of the top terminal is a separate piece.
const S_PATH = `M${point(232.5, 30.5, 19.5, -61)}A19.5 19.5 0 1 0 232.5 50A19.5 19.5 0 1 1 ${point(232.5, 69.5, 19.5, 145)}`;
const S_BIT = ringPiece(232.5, 30.5, 30.5, 8.5, -61, -35);

/** The round mark on its own. */
export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`logo-mark ${className}`} viewBox="0 0 100 100" width={size} height={size} aria-hidden focusable="false">
      <path d={O_PATH} />
    </svg>
  );
}

/** The full "OTS" wordmark. Height is the cap height; the nudged pieces overhang slightly. */
export function Logo({ height = 26 }: { height?: number }) {
  return (
    <svg className="logo" viewBox="-2 -8 280 118" height={(height * 118) / 100} width={(height * 280) / 100} role="img" aria-label="OTS" focusable="false">
      <path className="logo__o" d={O_PATH} />
      <path className="logo__letter" d={T_PATH} />
      <path className="logo__bit" d={T_BIT} />
      <path className="logo__stroke" d={S_PATH} />
      <path className="logo__bit" d={S_BIT} transform="translate(6 -4)" />
    </svg>
  );
}

const INTRO_KEY = 'ots:intro-played';

/** Play the opening once per browser session (or whenever the address has ?intro in it). */
export function shouldPlayIntro(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('intro') || sessionStorage.getItem(INTRO_KEY) === null;
  } catch {
    return true;
  }
}

/**
 * The opening: the O's five pieces start scattered across the screen, then fly
 * together into the mark — slice at the bottom included.
 */
export function Intro({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<'fly' | 'set' | 'leave'>('fly');

  // Where each piece starts: one per direction so they spread over the whole screen,
  // then shuffled so it is never the same piece in the same corner.
  const pieces = useMemo(() => {
    const spin = Math.random() * 360;
    const starts = O_PIECES.map((_, i) => {
      const angle = rad(spin + i * 72 + (Math.random() - 0.5) * 40);
      const turn = (90 + Math.random() * 200) * (Math.random() < 0.5 ? -1 : 1);
      return {
        '--x': `${(Math.cos(angle) * (24 + Math.random() * 20)).toFixed(1)}vw`,
        '--y': `${(Math.sin(angle) * (22 + Math.random() * 18)).toFixed(1)}vh`,
        '--r': `${turn.toFixed(0)}deg`,
        '--s': (0.8 + Math.random() * 0.7).toFixed(2),
      };
    }).sort(() => Math.random() - 0.5);
    return O_PIECES.map((d, i) => ({ d, style: { ...starts[i], '--d': `${i * 70}ms` } as CSSProperties }));
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(INTRO_KEY, '1');
    } catch {
      /* private mode: it will simply play again next time */
    }
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timers = [
      setTimeout(() => setPhase('set'), calm ? 0 : 1800),
      setTimeout(() => setPhase('leave'), calm ? 700 : 2350),
      setTimeout(onDone, calm ? 1000 : 2700),
    ];
    return () => timers.forEach(clearTimeout);
  }, [onDone]);

  return (
    <div className={`opening is-${phase}`} onClick={onDone} aria-hidden>
      <div className="opening__stage">
        {pieces.map((p, i) => (
          <svg key={i} className="opening__piece" viewBox="0 0 100 100" style={p.style} focusable="false">
            <path d={p.d} />
          </svg>
        ))}
        {/* Once the pieces have met, the one-piece mark takes over so no seams show. */}
        <svg className="opening__whole" viewBox="0 0 100 100" focusable="false">
          <path d={O_PATH} />
        </svg>
      </div>
    </div>
  );
}
