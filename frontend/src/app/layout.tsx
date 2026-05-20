import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'BBT Bridge - Cross-Chain Transfer',
  description: 'Bridge your BBT tokens across Solana, Ethereum, and BNB Chain',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <div className="min-h-screen bg-gradient-to-b from-dark-950 to-dark-900">
          <header className="border-b border-dark-800/50 backdrop-blur-xl bg-dark-950/80 sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between h-16">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-gradient-to-br from-primary-400 to-primary-600 rounded-lg flex items-center justify-center">
                    <span className="text-white font-bold text-sm">B</span>
                  </div>
                  <h1 className="text-xl font-bold bg-gradient-to-r from-white to-dark-300 bg-clip-text text-transparent">
                    BBT Bridge
                  </h1>
                </div>
                <nav className="flex items-center space-x-4">
                  <a
                    href="/"
                    className="text-dark-300 hover:text-white transition-colors"
                  >
                    Bridge
                  </a>
                  <a
                    href="/history"
                    className="text-dark-300 hover:text-white transition-colors"
                  >
                    History
                  </a>
                </nav>
              </div>
            </div>
          </header>
          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>
          <footer className="border-t border-dark-800/50 py-6 mt-auto">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center text-dark-500 text-sm">
              <p>BBT Bridge v0.1.0 - Cross-Chain Token Transfer</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
