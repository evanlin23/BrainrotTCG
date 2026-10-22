import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Download, Image as ImageIcon, Link2, Share2 } from 'lucide-react';
import { canCopyImage, canShareTo, copyImage, copyText, saveImage, shareTo } from '../../game/shareActions';
import Sheet from '../ui/Sheet';
import '../../styles/Share.css';

interface SharePreviewSheetProps {
  title: string;
  subtitle?: ReactNode;
  /** Draws the image to share; it's shown exactly as it will be sent. */
  makeImage: () => Promise<Blob>;
  imageName: string;
  /** The link to share; without one, only the image can be shared. */
  url?: string;
  /** Text that goes with a shared link or image. */
  text: string;
  onClose: () => void;
  /** More actions that belong with the share buttons, ahead of the preview (Hall of Fame). */
  actions?: ReactNode;
  /** Extra content under the preview (cards in the pack, notes). */
  children?: ReactNode;
}

/** Keep sharing actions ahead of the image so a tall preview cannot hide them on phones. */
const SharePreviewSheet = ({ title, subtitle, makeImage, imageName, url, text, onClose, actions, children }: SharePreviewSheetProps) => {
  const [image, setImage] = useState<{ blob: Blob; src: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [shareFailed, setShareFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a native share is pending, so a second tap cannot start another share.
  const sharing = useRef(false);

  useEffect(() => {
    let src = '';
    let cancelled = false;
    makeImage()
      .then((blob) => {
        if (cancelled) return;
        src = URL.createObjectURL(blob);
        setImage({ blob, src });
      })
      .catch((error: unknown) => {
        console.error('Could not draw the share image', error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (src) URL.revokeObjectURL(src);
    };
    // The image depends only on what was opened; makeImage is a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Only unmounting clears the pending message timer; redrawing the image must not cancel it early.
  useEffect(
    () => () => {
      if (doneTimer.current) clearTimeout(doneTimer.current);
    },
    [],
  );

  const onRetry = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  const flash = (message: string, isFailure = false) => {
    if (doneTimer.current) clearTimeout(doneTimer.current);
    setDone(message);
    setShareFailed(isFailure);
    doneTimer.current = setTimeout(() => {
      setDone(null);
      setShareFailed(false);
      doneTimer.current = null;
    }, isFailure ? 4000 : 1800);
  };

  const imageCopies = canCopyImage();
  const onCopyLink = async () => {
    if (url && (await copyText(url))) flash('Link copied');
  };
  const onImage = async () => {
    if (!image) return;
    if (imageCopies && (await copyImage(image.blob))) return flash('Image copied');
    saveImage(image.blob, imageName);
    flash('Image saved');
  };
  const onSave = () => {
    if (!image) return;
    saveImage(image.blob, imageName);
    flash('Image saved');
  };
  const onShareTo = async () => {
    if (!url && !image) return;
    if (sharing.current) return;
    sharing.current = true;
    if (doneTimer.current) {
      clearTimeout(doneTimer.current);
      doneTimer.current = null;
    }
    setDone(null);
    setShareFailed(false);
    let result: Awaited<ReturnType<typeof shareTo>>;
    try {
      result = await shareTo({ url, text, title, image: image ? { blob: image.blob, filename: imageName } : undefined });
    } finally {
      sharing.current = false;
    }
    if (result === 'failed') {
      if (url) {
        if (await copyText(url)) flash('Link copied');
      } else {
        const alternatives = image
          ? imageCopies
            ? 'Copy image, Save image or Copy text'
            : 'Save image or Copy text'
          : 'Copy text';
        flash(`Sharing failed — use ${alternatives}`, true);
      }
    }
  };

  return (
    <Sheet title={title} subtitle={subtitle} onClose={onClose} size="md" className="share-sheet">
      <div className="share-layout share-layout--actions-first">
        <div className="share-side">
          <div className="share-actions-main">
            {url && (
              <button type="button" className="btn btn--primary btn--block" onClick={onCopyLink}>
                <Link2 aria-hidden="true" /> Copy link
              </button>
            )}
            <button type="button" className={`btn ${url ? 'btn--secondary' : 'btn--primary'} btn--block`} onClick={onImage} disabled={!image}>
              {imageCopies ? <ImageIcon aria-hidden="true" /> : <Download aria-hidden="true" />} {imageCopies ? 'Copy image' : 'Save image'}
            </button>
          </div>

          <details className="share-disclosure">
            <summary>More sharing options</summary>
            <p className="share-more">
              {imageCopies && (
                <button type="button" className="link-btn" onClick={onSave} disabled={!image}>
                  <Download aria-hidden="true" /> Save image
                </button>
              )}
              <button type="button" className="link-btn" onClick={async () => (await copyText(text)) && flash('Text copied')}>
                <Copy aria-hidden="true" /> Copy text
              </button>
              {canShareTo() && (
                <button type="button" className="link-btn" onClick={onShareTo} disabled={!url && !image}>
                  <Share2 aria-hidden="true" /> Share to…
                </button>
              )}
            </p>
          </details>
          <p className={`share-done ${shareFailed ? 'is-failed' : ''}`} role="status">
            {done}
          </p>
          {actions}

          <figure className="share-preview">
            {image ? (
              <img src={image.src} alt="The image you'll share" />
            ) : (
              <span className="share-preview-wait" role="status">
                {failed ? (
                  <>
                    <span>Couldn't draw the image</span>
                    <button type="button" className="btn btn--secondary btn--sm share-retry-btn" onClick={onRetry}>
                      Retry
                    </button>
                  </>
                ) : (
                  'Drawing the image…'
                )}
              </span>
            )}
          </figure>

          {children}
        </div>
      </div>
    </Sheet>
  );
};

export default SharePreviewSheet;
