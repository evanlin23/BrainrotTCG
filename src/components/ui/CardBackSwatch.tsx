import cardBackImage from '../../assets/images/card_back.webp';
import '../../styles/Card.css';

/** A level-unlocked card back as a small picture (Profile's rewards and the next-goal chip); the id is a CARD_BACKS id. */
const CardBackSwatch = ({ id }: { id: string }) => (
  <span className={`back-swatch back-${id}`}>
    <img src={cardBackImage} alt="" className="card-back-image" draggable="false" />
  </span>
);

export default CardBackSwatch;
