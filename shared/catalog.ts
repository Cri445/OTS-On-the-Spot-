// The vocabulary hosts use to describe an activity and guests use to filter the map.
// Shared by the API (validation) and the web app (labels, colours, emoji).

export const VIBES = [
  { id: 'calm', label: 'Calm', emoji: '🌿', blurb: 'Easy-going. Bowling, board games, picnics.' },
  { id: 'lively', label: 'Lively', emoji: '🥂', blurb: 'Buzzing. Parties, karaoke, bar nights.' },
  { id: 'active', label: 'Active', emoji: '⚡', blurb: 'Get moving. Tennis, football, runs.' },
] as const;

export const CATEGORIES = [
  { id: 'party', label: 'Party', emoji: '🎉' },
  { id: 'sports', label: 'Sports', emoji: '🎾' },
  { id: 'games', label: 'Games', emoji: '🎳' },
  { id: 'food', label: 'Food & drinks', emoji: '🍻' },
  { id: 'music', label: 'Music', emoji: '🎶' },
  { id: 'outdoors', label: 'Outdoors', emoji: '🌳' },
  { id: 'arts', label: 'Arts & culture', emoji: '🎨' },
  { id: 'learning', label: 'Learning', emoji: '🧠' },
  { id: 'other', label: 'Something else', emoji: '✨' },
] as const;

export const TAGS = [
  { id: 'indoor', label: 'Indoor' },
  { id: 'outdoor', label: 'Outdoor' },
  { id: 'beginner-friendly', label: 'Beginner friendly' },
  { id: 'competitive', label: 'Competitive' },
  { id: 'small-group', label: 'Small group' },
  { id: 'big-crowd', label: 'Big crowd' },
  { id: 'drinks', label: 'Drinks' },
  { id: 'alcohol-free', label: 'Alcohol-free' },
  { id: 'food-included', label: 'Food included' },
  { id: 'byo', label: 'Bring your own' },
  { id: 'gear-provided', label: 'Gear provided' },
  { id: 'live-music', label: 'Live music' },
  { id: 'dancing', label: 'Dancing' },
  { id: 'pet-friendly', label: 'Pet friendly' },
  { id: 'step-free', label: 'Step-free access' },
  { id: 'lgbtq-friendly', label: 'LGBTQ+ friendly' },
] as const;

export type VibeId = (typeof VIBES)[number]['id'];
export type CategoryId = (typeof CATEGORIES)[number]['id'];
export type TagId = (typeof TAGS)[number]['id'];

export const VIBE_IDS = VIBES.map((v) => v.id) as [VibeId, ...VibeId[]];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]];
export const TAG_IDS = TAGS.map((t) => t.id) as [TagId, ...TagId[]];

export const vibeOf = (id: string) => VIBES.find((v) => v.id === id) ?? VIBES[0];
export const categoryOf = (id: string) => CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
export const tagLabel = (id: string) => TAGS.find((t) => t.id === id)?.label ?? id;
