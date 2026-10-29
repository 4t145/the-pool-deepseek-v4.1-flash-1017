import './styles.css';
import { App } from './app/App';
import { readSettings } from './app/settings';

const canvas = document.getElementById('c');
const api = new App(readSettings());

api
  .init()
  .then(() => {
    document.body.classList.add('ready');
  })
  .catch((error: unknown) => {
    console.error(error);
    const loader = document.getElementById('loader-status');
    if (loader) {
      loader.textContent = 'THE ROOM FAILED TO BUILD — SEE CONSOLE';
      loader.style.color = '#d84a32';
    }
    const title = document.getElementById('loader-fill');
    if (title) title.style.background = '#d84a32';
    void canvas;
  });
