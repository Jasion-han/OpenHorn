import type { AppProps } from 'next/app';
import 'ui/styles/tokens.css';
import '../app/globals.css';
import { AppProviders } from '@/components/providers/AppProviders';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <AppProviders>
      <Component {...pageProps} />
    </AppProviders>
  );
}
