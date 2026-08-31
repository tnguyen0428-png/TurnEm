import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { registerServiceWorker } from './utils/pushNotifications';

// Which build is this tab actually running? Vite content-hashes the bundle, so
// import.meta.url ends in `main-<hash>.js` and identifies the deploy exactly.
// Printed on boot because "is the fix live, or is this tab still on an older
// copy?" cost most of an afternoon on 2026-08-31: an installed-app window and a
// browser tab were open side by side across several deploys, and three rounds of
// "it still fails" were read as "the fix is wrong" when at least one of them was
// a stale bundle. Cheaper to answer in one glance than to infer from behaviour.
console.info('[turnem] build', import.meta.url);

registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
