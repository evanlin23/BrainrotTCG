// #1138 exploration: design-lab.html's entry (DESIGN_LAB=1 builds only). ?look=a|b|c picks the look.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/index.css';
import DesignLab from './DesignLab';
import { applyDesignLook } from '../../game/designLook';

applyDesignLook();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesignLab />
  </StrictMode>,
);
