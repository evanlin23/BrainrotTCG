import { HALL_OF_FAME_MIN_SCORE } from '../../engine';

/** The two ways into Rankings, worded once so the Rankings page, the Profile, the share sheet and the results screen agree. */
export const QUALIFY_HAND = 'a Full House or better';
export const QUALIFY_SCORE = `a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+`;
export const QUALIFY_RULE = `${QUALIFY_HAND}, or ${QUALIFY_SCORE}`;

/** The Rankings page section that explains Submit, named where Submit is missing (#1004). */
export const RANKINGS_HELP = 'How Rankings work';

/** Why a pull that doesn't qualify has no Submit, in one short sentence. */
export const NOT_QUALIFYING = `Doesn't qualify for Rankings, which take ${QUALIFY_RULE}. See ${RANKINGS_HELP}.`;
