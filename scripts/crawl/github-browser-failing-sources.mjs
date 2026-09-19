// Compatibility entry point; the workflow uses github-browser-gap-fill.mjs.
import { main } from './github-browser-gap-fill.mjs';
main().catch(error => { console.error(error.message); process.exitCode = 1; });
