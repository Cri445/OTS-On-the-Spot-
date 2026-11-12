import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import type { PublicProfile as Profile } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../app-context';
import { ActivityCard } from '../components/ActivityCard';
import { LoadState, UserAvatar, VerifiedBadge } from '../components/ui';
import { useLoad, useNow } from '../lib/use-load';

const since = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

/** What everyone can see about a member: their picture, name, bio, and what they're hosting. */
export function PublicProfile() {
  const id = Number(useParams().id);
  const { user } = useApp();
  const now = useNow();
  const { data: p, error, loading, reload } = useLoad(() => api<{ profile: Profile }>(`/users/${id}`).then((r) => r.profile), [id]);

  if (!p) {
    return (
      <div className="page">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="pagebar">
        <Link to="/" className="backlink">
          <ArrowLeft size={18} aria-hidden /> Map
        </Link>
        {user?.id === p.user.id && (
          <Link to="/profile" className="btn btn--ghost btn--sm">
            Edit my profile
          </Link>
        )}
      </div>

      <header className="profilehead profilehead--public">
        <UserAvatar user={p.user} size={112} />
        <div>
          <h1 className="pagetitle">{p.user.displayName}</h1>
          {p.user.verified && <VerifiedBadge />}
          <p className="muted">On OTS since {since.format(new Date(p.memberSince))}</p>
        </div>
      </header>

      {p.bio && <p className="prose">{p.bio}</p>}

      <section>
        <h2>Hosting</h2>
        {p.activities.length === 0 ? (
          <p className="muted">{p.user.displayName} isn't hosting anything right now.</p>
        ) : (
          <ul className="cards">
            {p.activities.map((a) => (
              <li key={a.id}>
                <ActivityCard a={a} now={now} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
