import { useEffect, useState, type ReactNode } from 'react';
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

  useEffect(() => {
    let src = '';
    let cancelled = false;
    makeImage()
      .then((blob) => {
        if (cancelled) return;
        src = URL.createObjectURL(blob);
        setImage({ blob, src });
      })
      .catch((error) => {
        console.error('Could not draw the share image', error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (src) URL.revokeObjectURL(src);
    };
    // The image depends only on what was opened; makeImage is a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (message: string) => {
    setDone(message);
    setTimeout(() => setDone(null), 1800);
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
    const result = await shareTo({ url, text, title, image: image ? { blob: image.blob, filename: imageName } : undefined });
    if (result === 'failed' && url && (await copyText(url))) flash('Link copied');
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
              <button type="button" className="link-btn" onClick={onShareTo}>
                <Share2 aria-hidden="true" /> Share to…
              </button>
            )}
          </p>
          <p className="share-done" role="status">
            {done}
          </p>
          {actions}

          <figure className="share-preview">
            {image ? (
              <img src={image.src} alt="The image you'll share" />
            ) : (
              <span className="share-preview-wait" role="status">
                {failed ? "Couldn't draw the image" : 'Drawing the image…'}
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
