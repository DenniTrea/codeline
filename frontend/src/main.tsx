import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/500.css';
import '@fontsource/press-start-2p/400.css';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/pixelify-sans/400.css';
import './style.css';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
