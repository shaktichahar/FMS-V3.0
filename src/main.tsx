import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      regs.forEach((reg) => {
        if (reg.active?.scriptURL.includes('dev-sw.js')) {
          void reg.unregister();
        }
      });
    })
    .catch(() => {});
}

createRoot(document.getElementById('root')!).render(<App />);
