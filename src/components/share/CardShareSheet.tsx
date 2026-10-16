import { useMemo } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Card } from '../../data/cards';
import { CARD_RARITIES, cardNumber } from '../../data/cards';
import { getLatestSet, setCode } from '../../content/sets';
import { getPlayer } from '../../game/player';
import { findPackWithCard } from '../../game/history';
import { cardPreviewPath } from '../../game/previewLinks';
import { canShare, proofFor, pullUrl, type PullRef } from '../../game/pulls';
import { renderCardPoster } from '../../game/bragImage';
import { modifierLabel } from '../../game/modifiers';
import type { CardVersion } from '../../game/versions';
import SharePreviewSheet from './SharePreviewSheet';

interface CardShareSheetProps {
  card: Card;
  /** The version being shared; the link goes to a pack with that exact version when there is one. */
  version: CardVersion;
  /**
   * The pack it came in, when the caller knows (the pack summary): the link and QR code then go to
   * that pack, the same pull the pack's own Share links to.
   */
  from?: PullRef;
  onClose: () => void;
}

const RARITY_COLORS: Record<string, string> = {
  COMMON: '#b8b4bd',
  UNCOMMON: '#5fd38d',
  RARE: '#6aa8ff',
  EPIC: '#c08bff',
  LEGENDARY: '#ffa24d',
  BRAINROT: '#ffd23f',
};

/**
 * Share one card from your collection: a poster of the card, with a link to the pack it came from
 * when this device has that pack, so the card is as verifiable as the pull.
 */
const CardShareSheet = ({ card, version, from, onClose }: CardShareSheetProps) => {
  const { isHolo, finish = null, misprint = false } = version;
  const mods = modifierLabel(version);
  const player = getPlayer();
  const set = getLatestSet(card.setId);
  const setName = set?.name ?? card.setId;
  const code = set ? setCode(set) : card.setId.toUpperCase();
  const number = cardNumber(card);
  const cardId = card.key.split('/')[1];

  const pack = useMemo((): PullRef | null => {
    if (from && canShare(from)) return from;
    const found = findPackWithCard(player.publicKeyHex, card.setId, cardId, { isHolo, finish, misprint });
    return found && { setId: found.setId, setVersion: found.setVersion, nonce: found.nonce, publicKeyHex: found.key };
  }, [from, player.publicKeyHex, card.setId, cardId, isHolo, finish, misprint]);
  const proof = useMemo(() => (pack ? proofFor(pack) : undefined), [pack]);
  // The QR code opens the pull directly; the pasted link previews as this card.
  const url = proof ? pullUrl(proof) : undefined;
  const link = proof ? pullUrl(proof, cardPreviewPath(card.setId, cardId)) : undefined;
  const rarity = CARD_RARITIES[card.rarity];
  const text = `${card.name} (${mods ? `${mods} ` : ''}${rarity.name}) from ${setName} in Brainrot TCG${link ? `\n${link}` : ''}`;

  return (
    <SharePreviewSheet
      title={`Share ${card.name}`}
      subtitle={`${rarity.symbol} ${mods ? `${mods} ` : ''}${rarity.name} · ${code} ${number}`}
      makeImage={() =>
        renderCardPoster({
          card: {
            image: card.image,
            name: card.name,
            isHolo,
            finish,
            misprint,
            rarityName: rarity.name,
            raritySymbol: rarity.symbol,
            rarityColor: RARITY_COLORS[card.rarity],
            number,
          },
          setName,
          setCode: code,
          setColor: set?.palette?.[0],
          playerName: player.name,
          fingerprint: player.fingerprint,
          url,
          cert: pack ? `${code} #${pack.nonce}` : undefined,
        })
      }
      imageName={`brainrot-${card.key.replace('/', '-')}${mods ? `-${mods.toLowerCase().replace(/ · /g, '-')}` : ''}.png`}
      url={link}
      text={text}
      onClose={onClose}
    >
      <p className="share-note">
        <ShieldCheck aria-hidden="true" />
        {url
          ? `The link opens the pack this ${mods ? `${mods.toLowerCase().replace(/ · /g, ' ')} ` : ''}card came from (ticket #${pack!.nonce}), re-checked on their device.`
          : "This card isn't in any pack this device has a record of (it came before verifiable pulls), so there's no link to prove it."}
      </p>
    </SharePreviewSheet>
  );
};

export default CardShareSheet;
