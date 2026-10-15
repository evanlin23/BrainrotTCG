import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import type { Finish } from '../../engine';
import { finishedCardImage } from '../../game/finishImage';
import { cardFinishThumbUrl } from '../../content/art';

interface CardImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  finish?: Finish | null;
  /** Collection tiles can use ready-made finishes instead of rendering a full-size image. */
  thumbnail?: boolean;
}

/** Keep the same img element and existing holo/misprint layers, changing only its printed frame. */
const CardImage = ({ src, finish, thumbnail = false, style, onError, draggable = false, ...props }: CardImageProps) => {
  const key = `${finish ?? ''}:${src}`;
  const [rendered, setRendered] = useState<{ key: string; src: string }>();
  const [failedThumb, setFailedThumb] = useState<string>();
  const availableThumb = thumbnail ? cardFinishThumbUrl(src, finish) : undefined;
  // A failed thumbnail falls back to the existing full-size finish renderer.
  const thumb = failedThumb === key ? undefined : availableThumb;
  const image = thumb ?? (rendered?.key === key ? rendered.src : undefined);
  useEffect(() => {
    if (!finish || thumb) return;
    let cancelled = false;
    finishedCardImage(src, finish).then((result) => {
      if (!cancelled) setRendered({ key, src: result });
    }).catch((error) => {
      console.error('Could not render card finish', error);
      if (!cancelled) setRendered({ key, src });
    });
    return () => { cancelled = true; };
  }, [src, finish, key, thumb]);
  // Keep the image's dimensions while its inks are prepared, without flashing the plain version.
  return <img draggable={draggable} {...props} src={image ?? src} onError={(event) => {
    if (thumb && event.currentTarget.getAttribute('src') === thumb) setFailedThumb(key);
    onError?.(event);
  }} style={{ ...style, ...(finish && !image ? { visibility: 'hidden' } : {}) }} />;
};

export default CardImage;
