/**
 * Work done ahead of the first pack, once the page is idle: the first pull only waits for mining
 * and the reveal, not for the miner to start or the card back to download.
 */
import cardBackImage from '../assets/images/card_back.webp';
import { whenIdle } from './idle';
import { warmUpMiner } from './ticketMiner';

/** Start the ticket worker and fetch the card back the reveal shows first. */
export const warmUpFirstPack = (): void => {
  whenIdle(() => {
    warmUpMiner();
    new Image().src = cardBackImage;
  });
};
