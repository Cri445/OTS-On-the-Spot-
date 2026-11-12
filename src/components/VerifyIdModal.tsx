import { useRef, useState } from 'react';
import { BadgeCheck, Camera, IdCard, ScanLine } from 'lucide-react';
import type { Me } from '../../shared/types';
import { errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { DemoNote, Modal, Spinner } from './ui';

type Step = 'details' | 'document' | 'checking' | 'done';

/**
 * ID verification. The flow is the real one — your details, then a scan of
 * your document — but in demo mode the scan never leaves this device and the
 * check always passes for adults.
 */
export function VerifyIdModal({ onClose, onVerified }: { onClose: () => void; onVerified?: () => void }) {
  const { config, setUser } = useApp();
  const [step, setStep] = useState<Step>('details');
  const [legalName, setLegalName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  function next(e: React.FormEvent) {
    e.preventDefault();
    if (legalName.trim().length < 3) return setError('Enter your full legal name, as on your ID.');
    if (!birthDate) return setError('Enter your date of birth.');
    setError(null);
    setStep('document');
  }

  async function verify() {
    setStep('checking');
    setError(null);
    try {
      const [res] = await Promise.all([
        post<{ user: Me }>('/me/verify-id', { legalName: legalName.trim(), birthDate }),
        new Promise((r) => setTimeout(r, 1400)), // let the "scanning" moment land
      ]);
      setUser(res.user);
      setStep('done');
      onVerified?.();
    } catch (err) {
      setError(errorMessage(err));
      setStep('details');
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(f));
  }

  return (
    <Modal title="Verify your ID" onClose={step === 'checking' ? () => {} : onClose}>
      {step === 'details' && (
        <form onSubmit={next} className="stack">
          <p className="lede">
            Verified members can join ID-only activities. Hosts of those activities see your legal name on their door list — nobody else does.
          </p>
          <label className="field">
            <span>Full legal name</span>
            <input className="input" value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="As printed on your ID" autoComplete="name" autoFocus />
          </label>
          <label className="field">
            <span>Date of birth</span>
            <input className="input" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} autoComplete="bday" />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn--primary btn--block">Continue</button>
        </form>
      )}

      {step === 'document' && (
        <div className="stack">
          <p className="lede">Scan the photo page of your passport, or the front of your ID card or driving licence.</p>
          <div className="idscan">
            {preview ? <img src={preview} alt="Your document" /> : <IdCard size={56} strokeWidth={1.2} aria-hidden />}
          </div>
          <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
          <div className="row">
            <button className="btn btn--ghost" onClick={() => file.current?.click()}>
              <Camera size={16} aria-hidden /> {preview ? 'Retake' : 'Take or upload a photo'}
            </button>
            {config.demoMode && !preview && (
              <button className="btn btn--ghost" onClick={verify}>
                <ScanLine size={16} aria-hidden /> Use a sample ID
              </button>
            )}
          </div>
          {config.demoMode && <DemoNote>Your photo stays on this device — nothing is uploaded or stored — and the check passes for anyone aged 18 or over.</DemoNote>}
          <button className="btn btn--primary btn--block" onClick={verify} disabled={!preview}>
            Verify my ID
          </button>
        </div>
      )}

      {step === 'checking' && (
        <div className="verify-state">
          <Spinner label="Checking your document" />
          <p>Checking your document…</p>
        </div>
      )}

      {step === 'done' && (
        <div className="verify-state">
          <BadgeCheck size={56} className="verify-state__ok" aria-hidden />
          <h3>You're verified</h3>
          <p>ID-only activities are now open to you.</p>
          <button className="btn btn--primary btn--block" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}
