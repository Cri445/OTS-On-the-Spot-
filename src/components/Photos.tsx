import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImagePlus, X } from 'lucide-react';
import type { Photo } from '../../shared/types';
import { errorMessage, upload } from '../api';
import { useApp } from '../app-context';
import { shrinkImage } from '../lib/images';
import { Spinner } from './ui';

export const MAX_PHOTOS = 8;

/** Where a host adds, orders and removes the pictures of their venue. The first one is the cover. */
export function PhotoPicker({ photos, onChange }: { photos: Photo[]; onChange: (photos: Photo[]) => void }) {
  const { toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  // Uploads finish one by one; keep the latest list at hand so none is lost.
  const latest = useRef(photos);
  latest.current = photos;

  async function add(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])].slice(0, MAX_PHOTOS - photos.length);
    e.target.value = '';
    setUploading(files.length);
    for (const file of files) {
      try {
        const small = await shrinkImage(file, { maxSide: 1600 });
        const photo = await upload<Photo>('/images', small);
        latest.current = [...latest.current, photo];
        onChange(latest.current);
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
      setUploading((n) => n - 1);
    }
  }

  const remove = (id: string) => onChange(photos.filter((p) => p.id !== id));
  const makeCover = (id: string) => onChange([photos.find((p) => p.id === id)!, ...photos.filter((p) => p.id !== id)]);

  return (
    <div className="photogrid">
      {photos.map((p, i) => (
        <figure key={p.id} className="photogrid__item">
          <img src={p.url} alt={`Photo ${i + 1} of the venue`} />
          {i === 0 ? (
            <figcaption className="tag tag--featured">Cover</figcaption>
          ) : (
            <button type="button" className="photogrid__cover" onClick={() => makeCover(p.id)}>
              Make cover
            </button>
          )}
          <button type="button" className="photogrid__remove" onClick={() => remove(p.id)} aria-label={`Remove photo ${i + 1}`}>
            <X size={16} />
          </button>
        </figure>
      ))}
      {photos.length < MAX_PHOTOS && (
        <button type="button" className="photogrid__add" onClick={() => input.current?.click()} disabled={uploading > 0}>
          {uploading > 0 ? <Spinner label="Uploading" /> : <ImagePlus size={24} aria-hidden />}
          <span>{uploading > 0 ? 'Uploading…' : photos.length ? 'Add more' : 'Add photos'}</span>
        </button>
      )}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={add} />
    </div>
  );
}

/** Full-screen viewer for an activity's photos. Arrow keys move, Escape closes. */
export function Lightbox({ photos, start, onClose }: { photos: Photo[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const many = photos.length > 1;
  const step = (by: number) => setIndex((i) => (i + by + photos.length) % photos.length);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'ArrowRight') setIndex((i) => (i + 1) % photos.length);
      if (e.key === 'ArrowLeft') setIndex((i) => (i - 1 + photos.length) % photos.length);
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [photos.length]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Photos" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <img src={photos[index].url} alt={`Photo ${index + 1} of ${photos.length}`} />
      <button className="lightbox__btn lightbox__close" onClick={onClose} aria-label="Close photos" autoFocus>
        <X size={22} />
      </button>
      {many && (
        <>
          <button className="lightbox__btn lightbox__prev" onClick={() => step(-1)} aria-label="Previous photo">
            <ChevronLeft size={26} />
          </button>
          <button className="lightbox__btn lightbox__next" onClick={() => step(1)} aria-label="Next photo">
            <ChevronRight size={26} />
          </button>
          <span className="lightbox__count">
            {index + 1} / {photos.length}
          </span>
        </>
      )}
    </div>
  );
}
