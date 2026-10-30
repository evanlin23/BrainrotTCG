import { HALL_OF_FAME_MIN_SCORE } from '../../engine';

/** The two ways into Rankings, worded once so the Rankings page, the Profile, the share sheet and the results screen agree. */
export const QUALIFY_HAND = 'a Full House or better';
export const QUALIFY_SCORE = `a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+`;
export const QUALIFY_RULE = `${QUALIFY_HAND}, or ${QUALIFY_SCORE}`;

/** The Rankings page section that explains Submit, named where Submit is missing (#1004). */
export const RANKINGS_HELP = 'How Rankings work';

/** The id of that section on the Rankings page: the section a link to it asks for (App's openPage). */
export const RANKINGS_HELP_ID = 'how-rankings-work';

/** Why a pull that doesn't qualify has no Submit, in one short sentence ending in the name of RANKINGS_HELP. */
export const NOT_QUALIFYING_LEAD = `Doesn't qualify for Rankings, which take ${QUALIFY_RULE}. See `;
export const NOT_QUALIFYING = `${NOT_QUALIFYING_LEAD}${RANKINGS_HELP}.`;

/** Why a pull that qualifies has no Submit because its score cannot beat the lowest listed score (#1072). */
export const NOT_BEATING_FLOOR_LEAD = "Qualifies, but wouldn't beat the lowest listed score. See ";

