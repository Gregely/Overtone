import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { setupPwa } from './pwa';
import './styles/global.css';
import { applyTheme, watchSystemTheme } from './theme';

applyTheme();
watchSystemTheme();
setupPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
