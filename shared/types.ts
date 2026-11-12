// Shapes of the JSON the API sends to the web app.
import type { CategoryId, TagId, VibeId } from './catalog';

export type Security = 'open' | 'verified';
export type GroupStatus = 'open' | 'holding' | 'confirmed' | 'cancelled';
export type PayMode = 'split' | 'leader';

export interface PublicUser {
  id: number;
  displayName: string;
  avatarColor: string;
  /** Their profile picture, if they have uploaded one. */
  avatarUrl: string | null;
  verified: boolean;
}

export interface Me extends PublicUser {
  email: string;
  bio: string;
  legalName: string | null;
  isAdmin: boolean;
  twoFactorEnabled: boolean;
}

/** What anyone can see about a member. */
export interface PublicProfile {
  user: PublicUser;
  bio: string;
  memberSince: string;
  activities: ActivitySummary[];
}

export interface Photo {
  id: string;
  url: string;
}

export interface PaymentMethodOption {
  id: string;
  label: string;
  hint: string;
}

export interface AppConfig {
  demoMode: boolean;
  currency: string;
  commissionBps: number;
  listingFeeCents: { standard: number; featured: number };
  refundCutoffMinutes: number;
  groupHoldMinutes: number;
  maxGroupSize: number;
  minPriceCents: number;
  maxPriceCents: number;
  minAccountAge: number;
  mapCenter: { lat: number; lng: number; zoom: number };
  tileUrl: string;
  tileAttribution: string;
  geocoderUrl: string;
  paymentMethods: PaymentMethodOption[];
}

export interface ActivitySummary {
  id: number;
  title: string;
  category: CategoryId;
  vibe: VibeId;
  tags: TagId[];
  lat: number;
  lng: number;
  /** True when the host hides the exact spot and this viewer hasn't joined yet. */
  approximate: boolean;
  address: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  spotsLeft: number;
  priceCents: number;
  security: Security;
  /** Guests must be at least this old on the day, checked against their verified ID. */
  minAge: number | null;
  featured: boolean;
  status: 'active' | 'cancelled';
  /** The first venue photo, if the host has added any. */
  coverUrl: string | null;
  host: PublicUser;
}

export interface TicketDTO {
  id: number;
  code: string;
  status: 'active' | 'cancelled';
  priceCents: number;
  checkedInAt: string | null;
  createdAt: string;
  groupCode: string | null;
  refundable: boolean;
  activity: ActivitySummary;
}

export interface ActivityDetail extends ActivitySummary {
  description: string;
  hideExact: boolean;
  goingCount: number;
  /** Names are only shared with the host and with people who are going. */
  going: { displayName: string; avatarColor: string; avatarUrl: string | null }[] | null;
  photos: Photo[];
  refundableUntil: string;
  viewer: {
    isHost: boolean;
    /** Verified, but not old enough for this activity's age limit. */
    tooYoung: boolean;
    ticket: TicketDTO | null;
    group: { code: string; status: GroupStatus; size: number } | null;
  };
}

export interface GroupMemberDTO {
  user: PublicUser;
  isLeader: boolean;
  paid: boolean;
  issues: string[];
}

export interface GroupDTO {
  code: string;
  status: GroupStatus;
  payMode: PayMode | null;
  holdExpiresAt: string | null;
  activity: ActivitySummary;
  members: GroupMemberDTO[];
  /** Reasons the leader can't lock the spots in yet. Empty means ready. */
  blockers: string[];
  shareCents: number;
  totalCents: number;
  viewer: { isMember: boolean; isLeader: boolean; paid: boolean };
}

export interface GroupListItem {
  code: string;
  status: GroupStatus;
  size: number;
  isLeader: boolean;
  activity: ActivitySummary;
}

export interface Attendee {
  ticketId: number;
  code: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  verified: boolean;
  /** Only present when the activity requires verified ID. */
  legalName: string | null;
  groupCode: string | null;
  priceCents: number;
  checkedInAt: string | null;
  joinedAt: string;
}

export interface HostingItem extends ActivitySummary {
  sold: number;
  checkedIn: number;
  grossCents: number;
  netCents: number;
}

export interface LedgerEntry {
  id: number;
  kind: string;
  amountCents: number;
  affectsBalance: boolean;
  memo: string;
  activityId: number | null;
  createdAt: string;
}

export interface WalletDTO {
  availableCents: number;
  pendingCents: number;
  paidOutCents: number;
  earnedCents: number;
  entries: LedgerEntry[];
}

export interface AdminStats {
  listingFeesCents: number;
  commissionCents: number;
  ticketVolumeCents: number;
  payoutsCents: number;
  users: number;
  verifiedUsers: number;
  activities: number;
  upcomingActivities: number;
  ticketsSold: number;
  recent: LedgerEntry[];
}

export interface ActivityInput {
  title: string;
  description: string;
  category: CategoryId;
  vibe: VibeId;
  tags: TagId[];
  lat: number;
  lng: number;
  address: string;
  hideExact: boolean;
  startsAt: string;
  endsAt: string;
  capacity: number;
  priceCents: number;
  security: Security;
  minAge: number | null;
  /** Ids of uploaded venue photos; the first is the cover. */
  photos: string[];
}
