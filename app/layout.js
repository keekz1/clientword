// Required by Next.js. The visible pages are the static files in /public (see next.config.mjs rewrites).
export default function RootLayout({ children }) {
  return (<html lang="en"><body>{children}</body></html>);
}
