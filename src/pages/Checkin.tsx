import { useEffect, useState } from 'react';
import { BadgeCheck, CircleAlert } from 'lucide-react';
import { Link, useParams } from 'react-router';
import type { Attendee } from '../../shared/types';
import { errorMessage, post } from '../api';
import { Spinner, VerifiedBadge } from '../components/ui';
import { formatTime, prettyCode } from '../lib/format';

interface Result {
  attendee: Attendee;
  activityId: number;
  activityTitle: string;
  alreadyCheckedIn: boolean;
}

// One request per code, even if the screen mounts twice (as React does in development).
const requests = new Map<string, Promise<Result>>();
function checkIn(code: string): Promise<Result> {
  let request = requests.get(code);
  if (!request) {
    request = post<Result>('/checkin', { code });
    requests.set(code, request);
    setTimeout(() => requests.delete(code), 3000);
  }
  return request;
}

/** Where the QR code on a ticket leads. Opened by the host, it checks the guest in. */
export function Checkin() {
  const code = useParams().code ?? '';
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    checkIn(code)
      .then((r) => live && setResult(r))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [code]);

  return (
    <div className="page page--narrow">
      <div className="authcard checkinresult">
        {!result && !error && <Spinner label="Checking the ticket" />}
        {error && (
          <>
            <CircleAlert size={56} className="is-bad" aria-hidden />
            <h1>Not checked in</h1>
            <p className="muted">{error}</p>
            <p className="fineprint">Only the host can check a ticket in. If you're a guest, show this QR code to your host.</p>
            <Link to="/hosting" className="btn btn--ghost btn--block">
              Go to my activities
            </Link>
          </>
        )}
        {result && (
          <>
            <BadgeCheck size={56} className="is-good" aria-hidden />
            <h1>{result.alreadyCheckedIn ? 'Already checked in' : 'Checked in'}</h1>
            <p className="checkinresult__name">{result.attendee.legalName ?? result.attendee.displayName}</p>
            {result.attendee.verified && <VerifiedBadge />}
            <p className="muted">
              {result.activityTitle} · ticket {prettyCode(result.attendee.code)}
              {result.alreadyCheckedIn && result.attendee.checkedInAt && ` · arrived ${formatTime(result.attendee.checkedInAt)}`}
            </p>
            <Link to={`/a/${result.activityId}/door`} className="btn btn--primary btn--block">
              Back to the door list
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
