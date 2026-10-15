/** Reload the page, e.g. to pick up a deploy. Saves live in storage, so this loses nothing. Its own module so tests can stub it. */
export const reloadPage = () => window.location.reload();
